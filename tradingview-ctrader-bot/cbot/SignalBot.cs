using System;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.FullAccess)]
    public class SignalBot : Robot
    {
        // ─── Parameters ───

        [Parameter("Relay Server URL", Group = "Connection",
            DefaultValue = "wss://your-relay.up.railway.app")]
        public string RelayUrl { get; set; }

        [Parameter("Default Notional ($)", Group = "Risk",
            DefaultValue = 150, MinValue = 1)]
        public double DefaultNotional { get; set; } = 150;

        [Parameter("Reconnect Delay (sec)", Group = "Connection",
            DefaultValue = 10, MinValue = 5, MaxValue = 60)]
        public int ReconnectDelaySec { get; set; } = 10;

        // ─── State ───
        private ClientWebSocket _ws;
        private CancellationTokenSource _cts;
        private TradingViewSignal _pendingSignal;
        private readonly object _signalLock = new();

        // ─── Lifecycle ───

        protected override void OnStart()
        {
            Print($"SignalBot v3 starting");
            Print($"Relay: {RelayUrl}");
            Print($"Notional: ${DefaultNotional}");

            _cts = new CancellationTokenSource();
            _ = RunWebSocketLoopAsync(_cts.Token);
        }

        protected override void OnTick()
        {
            TradingViewSignal signal = null;

            lock (_signalLock)
            {
                if (_pendingSignal != null)
                {
                    signal = _pendingSignal;
                    _pendingSignal = null;
                }
            }

            if (signal != null)
            {
                ProcessSignal(signal);
            }
        }

        protected override void OnStop()
        {
            Print("SignalBot stopping...");
            _cts?.Cancel();
            _ws?.Dispose();
        }

        // ─── WebSocket Loop (background) ───

        private async Task RunWebSocketLoopAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    _ws?.Dispose();
                    _ws = new ClientWebSocket();

                    var uri = RelayUrl;
                    if (!uri.StartsWith("ws://") && !uri.StartsWith("wss://"))
                        uri = $"wss://{uri}";

                    Print($"Connecting to {uri}...");
                    await _ws.ConnectAsync(new Uri(uri), ct);
                    Print("✅ WebSocket connected!");

                    var buffer = new byte[1024 * 64];

                    while (_ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
                    {
                        var result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);

                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            Print("Server closed connection");
                            break;
                        }

                        if (result.MessageType == WebSocketMessageType.Text)
                        {
                            // Handle multi-frame messages
                            var sb = new StringBuilder();
                            sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));

                            while (!result.EndOfMessage)
                            {
                                result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                                sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                            }

                            OnMessage(sb.ToString());
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Print($"WebSocket error: {ex.Message}");
                }

                if (!ct.IsCancellationRequested)
                {
                    Print($"Reconnecting in {ReconnectDelaySec}s...");
                    await Task.Delay(ReconnectDelaySec * 1000, ct);
                }
            }
        }

        // ─── Message Handler ───

        private void OnMessage(string json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                if (!root.TryGetProperty("type", out var typeProp))
                    return;

                var type = typeProp.GetString();

                if (type == "welcome")
                {
                    Print("Connected to relay server");
                    return;
                }

                if (type == "signal" && root.TryGetProperty("data", out var data))
                {
                    var signal = JsonSerializer.Deserialize<TradingViewSignal>(
                        data.GetRawText(),
                        new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

                    if (signal == null)
                    {
                        Print("Failed to parse signal");
                        return;
                    }

                    lock (_signalLock)
                    {
                        _pendingSignal = signal;
                    }

                    Print($"📩 Signal: {signal.Action} {signal.Symbol} @ {signal.Entry}");
                }
            }
            catch (Exception ex)
            {
                Print($"Parse error: {ex.Message}");
            }
        }

        // ─── Trade Execution ───

        private void ProcessSignal(TradingViewSignal signal)
        {
            try
            {
                var ctSymbol = ResolveSymbol(signal.Symbol);
                if (ctSymbol == null)
                    return;

                if (HasOpenPosition(ctSymbol))
                {
                    Print($"Position exists for {ctSymbol} — skipping");
                    return;
                }

                var symbol = Symbols.GetSymbol(ctSymbol);
                if (symbol == null)
                {
                    Print($"Symbol '{ctSymbol}' not found in account");
                    return;
                }

                bool isLong = signal.Action.EndsWith(" Long", StringComparison.OrdinalIgnoreCase);
                if (!isLong && !signal.Action.EndsWith(" Short", StringComparison.OrdinalIgnoreCase))
                {
                    Print($"Cannot parse direction from '{signal.Action}'");
                    return;
                }

                var tradeType = isLong ? TradeType.Buy : TradeType.Sell;
                double notional = signal.Notional > 0 ? signal.Notional : DefaultNotional;
                double midPrice = (symbol.Ask + symbol.Bid) / 2.0;
                long volume = NormVolume(symbol, (long)Math.Round(notional / midPrice));

                if (volume <= 0)
                {
                    Print($"Invalid volume {volume}");
                    return;
                }

                Print($"Placing {tradeType} {symbol.Name} Vol={volume} SL={signal.Sl} TP={signal.Tp1}");

                var tradeOp = ExecuteMarketOrder(
                    tradeType, symbol.Name, volume, "TradingView", signal.Sl, signal.Tp1);

                if (tradeOp == null || tradeOp.Error != null)
                {
                    Print($"❌ Trade failed: {tradeOp?.Error}");
                    return;
                }

                Print($"✅ Trade executed! ID={tradeOp.Position?.Id} Price={tradeOp.Position?.EntryPrice}");
            }
            catch (Exception ex)
            {
                Print($"ProcessSignal error: {ex.Message}");
            }
        }

        // ─── Helpers ───

        private bool HasOpenPosition(string symbolName)
        {
            foreach (var p in Positions)
                if (string.Equals(p.SymbolName, symbolName, StringComparison.OrdinalIgnoreCase))
                    return true;
            return false;
        }

        private string ResolveSymbol(string tvSymbol)
        {
            if (Symbols.GetSymbol(tvSymbol) != null)
                return tvSymbol;

            var parts = tvSymbol.Split(':');
            if (parts.Length > 1)
            {
                string suffix = parts[parts.Length - 1];
                if (Symbols.GetSymbol(suffix) != null)
                    return suffix;
            }

            Print($"Unmapped symbol '{tvSymbol}'");
            return null;
        }

        private long NormVolume(Symbol symbol, long vol)
        {
            double min = symbol.VolumeInUnitsMin;
            double step = symbol.VolumeInUnitsStep;
            double max = symbol.VolumeInUnitsMax;
            if (vol < min) vol = (long)min;
            if (step > 0) vol = (long)(Math.Round(vol / step) * step);
            if (vol > max) vol = (long)max;
            return vol;
        }

        // ─── Signal Model ───

        private class TradingViewSignal
        {
            [JsonPropertyName("Action")]
            public string Action { get; set; }
            [JsonPropertyName("entry")]
            public double Entry { get; set; }
            [JsonPropertyName("tp1")]
            public double Tp1 { get; set; }
            [JsonPropertyName("sl")]
            public double Sl { get; set; }
            [JsonPropertyName("symbol")]
            public string Symbol { get; set; }
            [JsonPropertyName("notional")]
            public double Notional { get; set; }
        }
    }
}
