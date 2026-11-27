using System.Net.Http.Headers;

namespace Shop;

public static class Checkout
{
    public static void MapCheckout(this WebApplication app)
    {
        // Can we still talk to the payments provider? The key is read on every call, so a new key works at once.
        app.MapGet("/api/checkout/health", async (IConfiguration config, IHttpClientFactory factory) =>
        {
            var keyFile = config["Payments:ApiKeyFile"] ?? "/work/secrets/payments.key";
            var key = File.Exists(keyFile) ? (await File.ReadAllTextAsync(keyFile)).Trim() : "";
            var http = factory.CreateClient();
            var req = new HttpRequestMessage(HttpMethod.Get, (config["Payments:BaseUrl"] ?? "http://payments.internal:9100") + "/v1/health");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            try
            {
                using var res = await http.SendAsync(req);
                return res.IsSuccessStatusCode
                    ? Results.Ok(new { payments = "ok" })
                    : Results.Json(new { payments = "rejected", status = (int)res.StatusCode }, statusCode: 502);
            }
            catch (HttpRequestException e)
            {
                return Results.Json(new { payments = "unreachable", error = e.Message }, statusCode: 502);
            }
        });
    }
}
