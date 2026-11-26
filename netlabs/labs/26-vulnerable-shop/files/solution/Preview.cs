using System.Text.RegularExpressions;

namespace Shop;

public static partial class Preview
{
    // Only these hosts may be fetched. An allow-list, not a block-list: there are too many ways to spell
    // 169.254.169.254 (decimal 2852039166, hex, IPv6-mapped, a DNS name that resolves to it) to block them all.
    static readonly HashSet<string> AllowedHosts = new(StringComparer.OrdinalIgnoreCase) { "cdn.shop.example" };

    public static void AddPreview(this WebApplicationBuilder builder)
    {
        builder.Services.AddHttpClient("preview", c => c.Timeout = TimeSpan.FromSeconds(3))
            // No redirects: an allowed host that redirects (cdn's /redirect?to=) would otherwise lead anywhere.
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, UseProxy = false });
    }

    public static void MapPreview(this WebApplication app)
    {
        app.MapGet("/api/preview", async (string url, IHttpClientFactory factory) =>
        {
            // Parse it the way HttpClient will, then check the parts: scheme, host (no user@host tricks), port.
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")
                || !AllowedHosts.Contains(uri.IdnHost) || !uri.IsDefaultPort || uri.UserInfo.Length > 0)
                return Results.BadRequest(new { error = "Previews are only made for links to cdn.shop.example." });
            var http = factory.CreateClient("preview");
            try
            {
                using var res = await http.GetAsync(uri);
                if ((int)res.StatusCode is >= 300 and < 400)
                    return Results.Ok(new { url, status = (int)res.StatusCode, title = "", snippet = "" });
                var text = await res.Content.ReadAsStringAsync();
                var title = TitleRe().Match(text).Groups[1].Value.Trim();
                return Results.Ok(new { url, status = (int)res.StatusCode, title, snippet = text.Length > 300 ? text[..300] : text });
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
            {
                return Results.Ok(new { url, status = 0, title = "", snippet = "Could not fetch the page." });
            }
        });
    }

    [GeneratedRegex("<title>(.*?)</title>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex TitleRe();
}
