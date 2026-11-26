using System.Diagnostics;
using System.Net;
using System.Text.RegularExpressions;

namespace Shop;

public static partial class Tools
{
    public static void MapTools(this WebApplication app)
    {
        // Support staff use this to check that a customer's smart-lamp hub answers: /api/tools/ping?host=10.0.0.5
        app.MapGet("/api/tools/ping", async (string host, HttpContext ctx) =>
        {
            if (Auth.User(ctx) is null) return Results.Unauthorized();
            // 1. Validate: an IP address or a plain host name. No leading '-' (that would be an option for ping).
            if (!IPAddress.TryParse(host, out _) && !HostName().IsMatch(host))
                return Results.BadRequest(new { error = "Give an IP address or a host name." });
            // 2. No shell: the program is started directly and the host is one argument, whatever it contains.
            var psi = new ProcessStartInfo("ping")
            {
                ArgumentList = { "-c", "1", "-W", "1", "--", host },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var p = Process.Start(psi)!;
            var output = await p.StandardOutput.ReadToEndAsync() + await p.StandardError.ReadToEndAsync();
            await p.WaitForExitAsync();
            return Results.Ok(new { host, output });
        });
    }

    [GeneratedRegex(@"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")]
    private static partial Regex HostName();
}
