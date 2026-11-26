using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeDojo;

/// <summary>
/// OpenTelemetry .NET for learner programs ("framework": "otel", "web+otel"). The server restores the SDK, the hosting
/// extensions, the ASP.NET Core and HttpClient instrumentation and the in-memory and OTLP exporters as packages it never
/// compiles against; its build copies their runtime files into otellibs/ (CodeDojo.csproj). Like EF Core and the test
/// libraries they are copied once into a cache folder keyed by their versions and loaded from there by a resolver.
///
/// Web steps also get a hosting startup (ASPNETCORE_HOSTINGSTARTUPASSEMBLIES, set by the module initializer) that adds
/// capture processors to whatever providers the learner's own AddOpenTelemetry() builds: their spans, metric points and
/// log records are what the hidden tests read (DojoOtel), and the run writes them to dojo-otel.json, which the check
/// result carries back to the page as a trace waterfall. Nothing is captured that the learner's SDK setup did not
/// produce: a missing AddSource, a sampler that drops everything or no WithLogging all show up as missing telemetry.
/// </summary>
public sealed partial class CSharpRunner
{
    readonly Lazy<OtelLib> _otel;

    /// <summary>Does a step's "framework" ("otel", "web+otel") ask for OpenTelemetry?</summary>
    public static bool HasOtel(string? framework) =>
        (framework ?? "").Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Contains("otel", StringComparer.OrdinalIgnoreCase);

    /// <summary>The file a run of an otel program leaves behind with what it captured (read by Checker).</summary>
    public const string OtelDumpFile = "dojo-otel.json";

    sealed class OtelLib
    {
        public required List<MetadataReference> Refs { get; init; }
        public required string Dir { get; init; }
        public required SyntaxTree Support { get; init; }
        public required SyntaxTree WebSupport { get; init; }

        static string Locate()
        {
            static bool Has(string d) => Directory.Exists(d) && File.Exists(Path.Combine(d, "OpenTelemetry.dll"));
            var here = Path.Combine(AppContext.BaseDirectory, "otellibs");
            if (Has(here)) return here;
            var built = typeof(CSharpRunner).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyMetadataAttribute), false)
                .OfType<System.Reflection.AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == "DojoOtelLibs")?.Value;
            if (built is { Length: > 0 } && Has(built)) return built;
            throw new InvalidOperationException("The OpenTelemetry libraries are missing: build the server (dotnet build server) so otellibs/ is created next to it.");
        }

        public static OtelLib Prepare()
        {
            var src = Locate();
            var files = Directory.GetFiles(src, "*.dll").Order(StringComparer.OrdinalIgnoreCase).ToList();
            var key = string.Join("|", files.Select(f => { var i = new FileInfo(f); return $"{i.Name}:{i.Length}:{i.LastWriteTimeUtc.Ticks}"; }));
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..12].ToLowerInvariant();
            var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "otel-" + hash);
            var ready = Path.Combine(dir, ".ready");
            if (File.Exists(ready) && files.Any(f => !File.Exists(Path.Combine(dir, Path.GetFileName(f)))))
            {
                try { Directory.Delete(dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
            if (!File.Exists(ready))
            {
                var staging = dir + "-" + Guid.NewGuid().ToString("N")[..8];
                Directory.CreateDirectory(staging);
                foreach (var f in files) File.Copy(f, Path.Combine(staging, Path.GetFileName(f)), true);
                File.WriteAllText(Path.Combine(staging, ".ready"), key);
                try { Directory.Move(staging, dir); }
                catch (IOException) { try { Directory.Delete(staging, true); } catch { } }
                if (!File.Exists(ready)) throw new InvalidOperationException("could not prepare the OpenTelemetry library folder " + dir);
            }
            return new OtelLib
            {
                Dir = dir,
                Refs = files.Select(f => (MetadataReference)MetadataReference.CreateFromFile(Path.Combine(dir, Path.GetFileName(f)))).ToList(),
                Support = CSharpSyntaxTree.ParseText(OtelSupportSource, Parse, path: "DojoOtel.cs", encoding: Encoding.UTF8),
                WebSupport = CSharpSyntaxTree.ParseText(OtelWebSupportSource, Parse, path: "DojoOtelWeb.cs", encoding: Encoding.UTF8),
            };
        }
    }

    string OtelRuntimeConfig(OtelLib otel, string? efDir)
    {
        var props = new Dictionary<string, object> { ["Dojo.OtelDir"] = otel.Dir };
        if (efDir is not null) props["Dojo.LibDir"] = efDir;
        return System.Text.Json.JsonSerializer.Serialize(new
        {
            runtimeOptions = new
            {
                tfm = $"net{Environment.Version.Major}.0",
                frameworks = new[]
                {
                    new { name = "Microsoft.NETCore.App", version = Environment.Version.ToString() },
                    new { name = "Microsoft.AspNetCore.App", version = _webDirVersion },
                },
                configProperties = props,
            },
        });
    }

    /// <summary>
    /// Compiled into every otel program: the usings an OpenTelemetry project has, a resolver for the SDK assemblies,
    /// and DojoOtel, the capture the hidden tests read. Console steps use the SDK directly (their own in-memory exporter).
    /// </summary>
    const string OtelSupportSource = """
        global using System.Diagnostics;
        global using System.Diagnostics.Metrics;
        global using Microsoft.Extensions.DependencyInjection;
        global using Microsoft.Extensions.Logging;
        global using OpenTelemetry;
        global using OpenTelemetry.Context.Propagation;
        global using OpenTelemetry.Logs;
        global using OpenTelemetry.Metrics;
        global using OpenTelemetry.Resources;
        global using OpenTelemetry.Trace;

        #nullable enable
        /// <summary>One log record as the OpenTelemetry SDK exported it (LogRecord objects are pooled, so this is a copy).</summary>
        public sealed record DojoLog(string Category, Microsoft.Extensions.Logging.LogLevel Level, string? Template, string? Message,
            string TraceId, string SpanId, IReadOnlyDictionary<string, object?> Attributes, string? Exception, string? Service);

        /// <summary>One metric point after a flush: its attributes and, by kind, its sum/count (histograms) or value.</summary>
        public sealed record DojoPoint(string Metric, string Unit, string Kind, IReadOnlyDictionary<string, object?> Tags,
            long Count, double Sum, double Value, double[] Bounds, long[] Buckets);

        public static class DojoOtel
        {
            static readonly object Gate = new();
            static readonly List<Activity> _spans = [];
            static readonly List<DojoLog> _logs = [];
            static readonly List<OpenTelemetry.Metrics.MetricSnapshot> _metrics = [];
            internal static IServiceProvider? Services;

            [System.Runtime.CompilerServices.ModuleInitializer]
            internal static void Init()
            {
                var dir = System.AppContext.GetData("Dojo.OtelDir") as string;
                if (!string.IsNullOrEmpty(dir))
                    System.Runtime.Loader.AssemblyLoadContext.Default.Resolving += (ctx, name) =>
                    {
                        var path = System.IO.Path.Combine(dir, name.Name + ".dll");
                        return System.IO.File.Exists(path) ? ctx.LoadFromAssemblyPath(path) : null;
                    };
                // Web steps: the hosting startup in this assembly adds the capture to the learner's providers.
                if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("DOJO_WEB_URL")))
                {
                    Environment.SetEnvironmentVariable("ASPNETCORE_HOSTINGSTARTUPASSEMBLIES", typeof(DojoOtel).Assembly.GetName().Name);
                    // The console stays quiet (Warning, set by the runner), but the OpenTelemetry logger sees the app's own
                    // Information logs, as it would in production; the framework's chatter stays out.
                    Environment.SetEnvironmentVariable("Logging__OpenTelemetry__LogLevel__Default", "Information");
                    Environment.SetEnvironmentVariable("Logging__OpenTelemetry__LogLevel__Microsoft", "Warning");
                    Environment.SetEnvironmentVariable("Logging__OpenTelemetry__LogLevel__System.Net.Http", "Warning");
                    AppDomain.CurrentDomain.ProcessExit += (_, _) => Dump();
                }
            }

            internal static void Add(Activity a) { lock (Gate) _spans.Add(a); }
            internal static void Add(DojoLog l) { lock (Gate) _logs.Add(l); }
            internal static ICollection<OpenTelemetry.Metrics.MetricSnapshot> MetricSink => _metrics;

            /// <summary>Every span the learner's tracer provider ended so far, oldest first.</summary>
            public static List<Activity> Spans { get { lock (Gate) return [.. _spans]; } }

            /// <summary>Every log record the learner's logger provider exported so far.</summary>
            public static List<DojoLog> Logs { get { lock (Gate) return [.. _logs]; } }

            /// <summary>Server spans end just after the response is sent: wait (up to 3 s) until a span matches.</summary>
            public static async Task<Activity?> Span(Func<Activity, bool> match, int timeoutMs = 3000)
            {
                var until = Environment.TickCount64 + timeoutMs;
                while (true)
                {
                    var hit = Spans.LastOrDefault(match);
                    if (hit is not null || Environment.TickCount64 > until) return hit;
                    await Task.Delay(25);
                }
            }

            /// <summary>Wait until no new span has ended for a short while (background work, downstream calls).</summary>
            public static async Task Settle(int quietMs = 250, int timeoutMs = 3000)
            {
                var until = Environment.TickCount64 + timeoutMs;
                var seen = -1;
                while (Environment.TickCount64 < until)
                {
                    var n = Spans.Count;
                    if (n == seen) return;
                    seen = n;
                    await Task.Delay(quietMs);
                }
            }

            /// <summary>Force the learner's providers to export now (metrics are otherwise exported once a minute).</summary>
            public static void Flush()
            {
                if (Services is null) return;
                (Services.GetService(typeof(TracerProvider)) as TracerProvider)?.ForceFlush(2000);
                (Services.GetService(typeof(LoggerProvider)) as LoggerProvider)?.ForceFlush(2000);
                if (Services.GetService(typeof(MeterProvider)) is MeterProvider mp) { lock (Gate) _metrics.Clear(); mp.ForceFlush(2000); }
            }

            /// <summary>The points of one metric after a Flush (cumulative totals since the app started).</summary>
            public static List<DojoPoint> Points(string metric)
            {
                List<OpenTelemetry.Metrics.MetricSnapshot> all;
                lock (Gate) all = [.. _metrics];
                var list = new List<DojoPoint>();
                foreach (var m in all.Where(m => m.Name == metric))
                    foreach (var p in m.MetricPoints)
                    {
                        var tags = new Dictionary<string, object?>();
                        foreach (var t in p.Tags) tags[t.Key] = t.Value;
                        var kind = m.MetricType.ToString();
                        long count = 0; double sum = 0, value = 0; double[] bounds = []; long[] buckets = [];
                        if (m.MetricType == MetricType.Histogram)
                        {
                            count = p.GetHistogramCount(); sum = p.GetHistogramSum();
                            var b = new List<double>(); var c = new List<long>();
                            foreach (var bucket in p.GetHistogramBuckets()) { b.Add(bucket.ExplicitBound); c.Add(bucket.BucketCount); }
                            bounds = [.. b]; buckets = [.. c];
                        }
                        else if (m.MetricType is MetricType.LongSum or MetricType.LongGauge or MetricType.LongSumNonMonotonic) value = p.GetSumLong();
                        else value = m.MetricType is MetricType.DoubleGauge ? p.GetGaugeLastValueDouble() : p.GetSumDouble();
                        if (m.MetricType is MetricType.LongGauge) value = p.GetGaugeLastValueLong();
                        list.Add(new DojoPoint(m.Name, m.Unit, kind, tags, count, sum, value, bounds, buckets));
                    }
                return list;
            }

            /// <summary>A span attribute as text ("" when it is missing).</summary>
            public static string Tag(Activity? a, string key) => a?.GetTagItem(key) switch { null => "", var v => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) ?? "" };

            internal static string? ServiceOf(BaseProvider? provider)
            {
                try
                {
                    var res = provider?.GetResource();
                    return res?.Attributes.FirstOrDefault(a => a.Key == "service.name").Value as string;
                }
                catch { return null; }
            }

            internal static readonly Dictionary<string, string> SpanService = [];

            /// <summary>What the run captured, for the waterfall the check result shows (written when the program exits).</summary>
            internal static void Dump()
            {
                try
                {
                    var spans = Spans;
                    if (spans.Count == 0 && Logs.Count == 0) return;
                    var t0 = spans.Count > 0 ? spans.Min(s => s.StartTimeUtc) : DateTime.UtcNow;
                    var traces = spans.GroupBy(s => s.TraceId.ToHexString()).Take(12).Select(g => new
                    {
                        traceId = g.Key,
                        spans = g.Take(80).Select(s => new
                        {
                            id = s.SpanId.ToHexString(),
                            parent = s.ParentSpanId == default ? null : s.ParentSpanId.ToHexString(),
                            service = SpanService.TryGetValue(s.SpanId.ToHexString(), out var svc) ? svc : null,
                            name = s.DisplayName,
                            scope = s.Source.Name,
                            kind = s.Kind.ToString().ToLowerInvariant(),
                            start = Math.Round((s.StartTimeUtc - t0).TotalMilliseconds, 2),
                            dur = Math.Round(s.Duration.TotalMilliseconds, 2),
                            status = s.Status switch { ActivityStatusCode.Error => "error", ActivityStatusCode.Ok => "ok", _ => "unset" },
                            statusMsg = s.StatusDescription,
                            attrs = s.TagObjects.Take(40).ToDictionary(t => t.Key, t => Convert.ToString(t.Value, System.Globalization.CultureInfo.InvariantCulture)),
                            events = s.Events.Take(10).Select(e => new { t = Math.Round((e.Timestamp.UtcDateTime - t0).TotalMilliseconds, 2), name = e.Name, attrs = e.Tags.ToDictionary(t => t.Key, t => Convert.ToString(t.Value, System.Globalization.CultureInfo.InvariantCulture)) }),
                            links = s.Links.Select(l => new { traceId = l.Context.TraceId.ToHexString(), spanId = l.Context.SpanId.ToHexString() }),
                        }),
                    });
                    var logs = Logs.Take(60).Select(l => new { level = l.Level.ToString(), category = l.Category, body = l.Message ?? l.Template, template = l.Template, traceId = l.TraceId, spanId = l.SpanId, service = l.Service,
                        attrs = l.Attributes.Where(a => a.Key != "{OriginalFormat}").ToDictionary(a => a.Key, a => Convert.ToString(a.Value, System.Globalization.CultureInfo.InvariantCulture)) });
                    var json = System.Text.Json.JsonSerializer.Serialize(new { traces, logs });
                    System.IO.File.WriteAllText(System.IO.Path.Combine(System.AppContext.BaseDirectory, "dojo-otel.json"), json);
                }
                catch { /* a dump is a nicety; never fail the run over it */ }
            }

            /// <summary>Keeps every span the learner's tracer provider ends (after sampling and their own processors).</summary>
            internal sealed class SpanCapture : BaseProcessor<Activity>
            {
                public override void OnEnd(Activity data)
                {
                    if (ServiceOf(ParentProvider) is { } svc) lock (Gate) SpanService[data.SpanId.ToHexString()] = svc;
                    Add(data);
                }
            }

            /// <summary>Copies every log record the learner's logger provider exports.</summary>
            internal sealed class LogCapture : BaseProcessor<LogRecord>
            {
                public override void OnEnd(LogRecord r)
                {
                    var attrs = new Dictionary<string, object?>();
                    string? template = null;
                    foreach (var kv in r.Attributes ?? [])
                    {
                        if (kv.Key == "{OriginalFormat}") template = kv.Value as string;
                        attrs[kv.Key] = kv.Value;
                    }
                    template ??= r.Body;
                    Add(new DojoLog(r.CategoryName ?? "", r.LogLevel, template, r.FormattedMessage ?? r.Body,
                        r.TraceId == default ? "" : r.TraceId.ToHexString(), r.SpanId == default ? "" : r.SpanId.ToHexString(),
                        attrs, r.Exception?.GetType().Name, ServiceOf(ParentProvider)));
                }
            }
        }
        """;

    /// <summary>Web steps: the hosting startup that adds DojoOtel's capture to the learner's providers.</summary>
    const string OtelWebSupportSource = """
        #nullable enable
        [assembly: Microsoft.AspNetCore.Hosting.HostingStartup(typeof(DojoOtelStartup))]

        internal sealed class DojoOtelStartup : Microsoft.AspNetCore.Hosting.IHostingStartup
        {
            public void Configure(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder) => builder.ConfigureServices(services =>
            {
                services.ConfigureOpenTelemetryTracerProvider(t => t.AddProcessor(new DojoOtel.SpanCapture()));
                services.ConfigureOpenTelemetryLoggerProvider(l => l.AddProcessor(new DojoOtel.LogCapture()));
                services.ConfigureOpenTelemetryMeterProvider(m => m.AddInMemoryExporter(DojoOtel.MetricSink,
                    o => o.PeriodicExportingMetricReaderOptions.ExportIntervalMilliseconds = 600_000));
                services.AddSingleton<Microsoft.AspNetCore.Hosting.IStartupFilter, DojoOtelGrab>();
            });
        }

        /// <summary>Remembers the app's service provider so the tests can flush the learner's providers.</summary>
        internal sealed class DojoOtelGrab : Microsoft.AspNetCore.Hosting.IStartupFilter
        {
            public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
            {
                DojoOtel.Services = app.ApplicationServices;
                // Resolving the providers builds them, so instrumentation is listening before the first request.
                _ = app.ApplicationServices.GetService<OpenTelemetry.Trace.TracerProvider>();
                _ = app.ApplicationServices.GetService<OpenTelemetry.Metrics.MeterProvider>();
                next(app);
            };
        }
        """;
}
