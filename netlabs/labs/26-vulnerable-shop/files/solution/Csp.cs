using System.Security.Cryptography;

namespace Shop;

/// <summary>
/// A strict Content-Security-Policy: only scripts that carry this response's random nonce run. An injected
/// &lt;script&gt; or onerror= handler has no nonce, so the browser refuses it, even if encoding is missed somewhere.
/// </summary>
public static class Csp
{
    public static string Nonce(HttpContext ctx) => ctx.Items["csp-nonce"] as string ?? "";

    public static void UseContentSecurityPolicy(this WebApplication app)
    {
        app.Use(async (ctx, next) =>
        {
            var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
            ctx.Items["csp-nonce"] = nonce;
            ctx.Response.Headers.ContentSecurityPolicy =
                $"default-src 'self'; script-src 'nonce-{nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
            await next();
        });
    }
}
