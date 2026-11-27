using System.Text.RegularExpressions;

namespace Shop;

public static partial class Preview
{
    public static void AddPreview(this WebApplicationBuilder builder)
    {
        builder.Services.AddHttpClient("preview", c => c.Timeout = TimeSpan.FromSeconds(3));
    }

    public static void MapPreview(this WebApplication app)
    {
        // Link previews for reviews: the page shows the title of a link a reviewer pasted.
        // /api/preview?url=http://cdn.shop.example/specs/desk-lamp.html
        app.MapGet("/api/preview", async (string url, IHttpClientFactory factory) =>
        {
            var http = factory.CreateClient("preview");
            try
            {
                using var res = await http.GetAsync(url);
                var text = await res.Content.ReadAsStringAsync();
                var title = TitleRe().Match(text).Groups[1].Value.Trim();
                return Results.Ok(new { url, status = (int)res.StatusCode, title, snippet = text.Length > 1500 ? text[..1500] : text });
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException or InvalidOperationException)
            {
                return Results.Ok(new { url, status = 0, title = "", snippet = "Could not fetch: " + e.Message });
            }
        });
    }

    [GeneratedRegex("<title>(.*?)</title>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex TitleRe();
}
