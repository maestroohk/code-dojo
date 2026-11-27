using System.Diagnostics;

namespace Shop;

public static class Tools
{
    public static void MapTools(this WebApplication app)
    {
        // Support staff use this to check that a customer's smart-lamp hub answers: /api/tools/ping?host=10.0.0.5
        app.MapGet("/api/tools/ping", async (string host, HttpContext ctx) =>
        {
            if (Auth.User(ctx) is null) return Results.Unauthorized();
            var psi = new ProcessStartInfo("/bin/sh", $"-c \"ping -c 1 -W 1 {host}\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var p = Process.Start(psi)!;
            var output = await p.StandardOutput.ReadToEndAsync() + await p.StandardError.ReadToEndAsync();
            await p.WaitForExitAsync();
            return Results.Ok(new { host, output });
        });
    }
}
