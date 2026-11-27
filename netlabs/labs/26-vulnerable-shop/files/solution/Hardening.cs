namespace Shop;

/// <summary>Error handling and the response headers every answer gets.</summary>
public static class Hardening
{
    public static void AddHardening(this WebApplicationBuilder builder)
    {
        builder.Services.AddProblemDetails();                              // errors become RFC 9457 problem+json
        builder.WebHost.ConfigureKestrel(k => k.AddServerHeader = false);  // no "Server: Kestrel"
    }

    public static void UseHardening(this WebApplication app)
    {
        // Visitors get a plain 500 with no stack trace; the details go to the log, where developers look.
        // (UseDeveloperExceptionPage belongs only inside `if (app.Environment.IsDevelopment())`.)
        app.UseExceptionHandler();
        app.UseStatusCodePages();
        app.Use(async (ctx, next) =>
        {
            var h = ctx.Response.Headers;
            h.XContentTypeOptions = "nosniff";                  // never guess a script out of a text file
            h.XFrameOptions = "DENY";                           // no framing (older browsers; CSP frame-ancestors for new)
            h["Referrer-Policy"] = "strict-origin-when-cross-origin";
            h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
            await next();
        });
        // HSTS only means something over HTTPS: app.UseHsts() adds the header there, and the lab has no HTTPS.
        app.UseHsts();
    }
}
