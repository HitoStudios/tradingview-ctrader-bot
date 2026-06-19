using System;
using System.Collections.Generic;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.FullAccess)]
    public class SignalBot : Robot
    {
        // ─── Parameters ───

        [Parameter("Vercel Base URL", Group = "Webhook", DefaultValue = "https://your-project.vercel.app")]
        public string VercelBaseUrl { get; set; }

        [Parameter("Polling Interval (sec)", Group = "Webhook", DefaultValue = 10, MinValue = 5, MaxValue = 60)]
        public int PollingIntervalSeconds { get; set; } = 10;

        [Parameter("Default Notional ($)", Group = "Risk", DefaultValue = 150, MinValue = 1)]
        public double DefaultNotional { get; set; } = 150;

        [Parameter("Symbol Mappings", Group = "Symbols", DefaultValue = "NASDAQ:US100:US100")]
        public string SymbolMappingsRaw { get; set; }

        [Parameter("TP1 Fraction", Group = "Take Profits", DefaultValue = 0.34, MinValue = 0.01, MaxValue = 1.0)]
        public double Tp1Fraction { get; set; } = 0.34;

        [Parameter("TP2 Fraction", Group = "Take Profits", DefaultValue = 0.33, MinValue = 0.0, MaxValue = 1.0)]
        public double Tp2Fraction { get; set; } = 0.33;

        [Parameter("TP3 Fraction", Group = "Take Profits", DefaultValue = 0.33, MinValue = 0.0, MaxValue = 1.0)]
        public double Tp3Fraction { get; set; } = 0.33;

        // ─── State ───
        private System.Net.Http.HttpClient _httpClient;
        private DateTime _lastPollTime = DateTime.MinValue;
        private string _lastProcessedSignalId = "";

        private const string SignalPath = "/api/latest-signal";

        // ─── Lifecycle ───

        protected override void OnStart()
        {
            Print("SignalBot starting...");

            _httpClient = new System.Net.Http.HttpClient();
            _httpClient.Timeout = TimeSpan.FromSeconds(10);
            _httpClient.DefaultRequestHeaders.Accept.Add(
                new MediaTypeWithQualityHeaderValue("application/json"));

            VercelBaseUrl = VercelBaseUrl.TrimEnd('/');
            Print($"Polling {VercelBaseUrl}{SignalPath} every {PollingIntervalSeconds}s");
        }

        protected override void OnTick()
        {
            var elapsed = (DateTime.UtcNow - _lastPollTime).TotalSeconds;
            if (elapsed >= PollingIntervalSeconds)
            {
                _lastPollTime = DateTime.UtcNow;
                _ = PollAndProcessAsync();
            }
        }

        protected override void OnStop()
        {
            Print("SignalBot stopping...");
            _httpClient?.Dispose();
        }

        // ─── Core ───

        private async Task PollAndProcessAsync()
        {
            try
            {
                var signal = await FetchSignalAsync();
                if (signal == null || signal.Id == _lastProcessedSignalId)
                    return;

                Print($"Signal: {signal.Action} | {signal.Symbol} | Entry={signal.Entry}");

                var ctSymbol = ResolveSymbol(signal.Symbol);
                if (ctSymbol == null) { await ConsumeAsync(); return; }

                if (HasOpenPosition(ctSymbol))
                {
                    Print($"Position exists for {ctSymbol} — skipping");
                    await ConsumeAsync();
                    return;
                }

                var symbol = Symbols.GetSymbol(ctSymbol);
                if (symbol == null)
                {
                    Print($"Symbol '{ctSymbol}' not found in account");
                    await ConsumeAsync();
                    return;
                }

                bool isLong = signal.Action.EndsWith(" Long", StringComparison.OrdinalIgnoreCase);

                if (!isLong && !signal.Action.EndsWith(" Short", StringComparison.OrdinalIgnoreCase))
                {
                    Print($"Cannot parse direction from '{signal.Action}'");
                    await ConsumeAsync();
                    return;
                }

                var tradeType = isLong ? TradeType.Buy : TradeType.Sell;
                double notional = signal.Notional > 0 ? signal.Notional : DefaultNotional;
                long volume = NormVolume(symbol, (long)(notional / ((symbol.Ask + symbol.Bid) / 2.0)));
                if (volume <= 0)
                {
                    Print($"Invalid volume {volume}");
                    await ConsumeAsync();
                    return;
                }

                // Place market order
                Print($"Placing {tradeType} {symbol.Name} Vol={volume} SL={signal.Sl} TP1={signal.Tp1}");
                var tradeOp = ExecuteMarketOrder(
                    tradeType, symbol.Name, volume, "TradingView", signal.Sl, signal.Tp1);

                if (tradeOp == null || !string.IsNullOrEmpty(tradeOp.Error))
                {
                    Print($"Market order failed: {tradeOp?.Error ?? "null"}");
                    await ConsumeAsync();
                    return;
                }

                // Find the opened position
                Position pos = FindPosition(symbol.Name, "TradingView");
                if (pos == null)
                {
                    Print("Market order succeeded but position not found");
                    await ConsumeAsync();
                    return;
                }

                Print($"Position opened: ID={pos.Id} Price={pos.EntryPrice} Vol={pos.Volume}");

                // Place TP2 and TP3 as separate pending limit orders
                var fractions = new[] { Tp1Fraction, Tp2Fraction, Tp3Fraction };
                var tpPrices = new[] { signal.Tp1, signal.Tp2, signal.Tp3 };
                var tpLabels = new[] { "TP1", "TP2", "TP3" };
                var opposite = tradeType == TradeType.Buy ? TradeType.Sell : TradeType.Buy;

                for (int i = 1; i < 3; i++)
                {
                    if (tpPrices[i] <= 0 || fractions[i] <= 0) continue;

                    long tpVol = NormVolume(symbol, (long)((double)volume * fractions[i]));
                    if (tpVol < symbol.VolumeInUnitsMin)
                    {
                        Print($"  {tpLabels[i]} vol {tpVol} < min — skipping");
                        continue;
                    }

                    var limitOp = ExecuteLimitOrder(
                        opposite, symbol.Name, tpVol, tpPrices[i],
                        tpLabels[i] + "_" + pos.Id, null, null, null, null, null, null);

                    if (limitOp != null && string.IsNullOrEmpty(limitOp.Error))
                        Print($"  {tpLabels[i]} limit order at {tpPrices[i]} for {tpVol}");
                    else
                        Print($"  {tpLabels[i]} limit order failed: {limitOp?.Error ?? "null"}");
                }

                _lastProcessedSignalId = signal.Id;
                await ConsumeAsync();
                Print($"Done — {signal.Action} on {symbol.Name}");
            }
            catch (Exception ex)
            {
                Print($"Error: {ex.Message}");
            }
        }

        // ─── HTTP ───

        private async Task<TradingViewSignal> FetchSignalAsync()
        {
            try
            {
                var res = await _httpClient.GetAsync($"{VercelBaseUrl}{SignalPath}");
                if (res.StatusCode == System.Net.HttpStatusCode.NoContent) return null;
                res.EnsureSuccessStatusCode();
                var json = await res.Content.ReadAsStringAsync();
                return string.IsNullOrWhiteSpace(json)
                    ? null
                    : JsonSerializer.Deserialize<TradingViewSignal>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            }
            catch (Exception ex)
            {
                Print($"HTTP error: {ex.Message}");
                return null;
            }
        }

        private async Task ConsumeAsync()
        {
            try
            {
                var req = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Delete, $"{VercelBaseUrl}{SignalPath}");
                var res = await _httpClient.SendAsync(req);
                Print($"Signal consumed ({res.StatusCode})");
            }
            catch (Exception ex)
            {
                Print($"Consume error: {ex.Message}");
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

        private Position FindPosition(string symbolName, string label)
        {
            foreach (var p in Positions)
                if (string.Equals(p.SymbolName, symbolName, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(p.Label, label, StringComparison.OrdinalIgnoreCase))
                    return p;
            return null;
        }

        private string ResolveSymbol(string tvSymbol)
        {
            if (Symbols.GetSymbol(tvSymbol) != null) return tvSymbol;

            // Check from mappings
            var parts = tvSymbol.Split(':');
            if (parts.Length > 1)
            {
                string suffix = parts[parts.Length - 1];
                if (Symbols.GetSymbol(suffix) != null) return suffix;
            }

            // If mappings param was filled, split and check
            if (!string.IsNullOrWhiteSpace(SymbolMappingsRaw))
            {
                foreach (var entry in SymbolMappingsRaw.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    var mapParts = entry.Split(':');
                    if (mapParts.Length >= 2)
                    {
                        var from = string.Join(":", mapParts, 0, mapParts.Length - 1).Trim();
                        var to = mapParts[mapParts.Length - 1].Trim();
                        if (string.Equals(from, tvSymbol, StringComparison.OrdinalIgnoreCase))
                            return to;
                    }
                }
            }

            Print($"Unmapped symbol '{tvSymbol}'");
            return null;
        }

        private long NormVolume(Symbol symbol, long vol)
        {
            if (vol < symbol.VolumeInUnitsMin) vol = symbol.VolumeInUnitsMin;
            long step = symbol.VolumeInUnitsStep;
            if (step > 0) vol = (long)(Math.Round((double)vol / step) * step);
            if (vol > symbol.VolumeInUnitsMax) vol = symbol.VolumeInUnitsMax;
            return vol;
        }

        // ─── Signal Model ───

        private class TradingViewSignal
        {
            [JsonPropertyName("_id")]
            public string Id { get; set; }
            [JsonPropertyName("Action")]
            public string Action { get; set; }
            [JsonPropertyName("entry")]
            public double Entry { get; set; }
            [JsonPropertyName("tp1")]
            public double Tp1 { get; set; }
            [JsonPropertyName("tp2")]
            public double Tp2 { get; set; }
            [JsonPropertyName("tp3")]
            public double Tp3 { get; set; }
            [JsonPropertyName("sl")]
            public double Sl { get; set; }
            [JsonPropertyName("symbol")]
            public string Symbol { get; set; }
            [JsonPropertyName("notional")]
            public double Notional { get; set; }
            [JsonPropertyName("_receivedAt")]
            public string ReceivedAt { get; set; }
        }
    }
}
