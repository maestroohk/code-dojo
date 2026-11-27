namespace Shop;

public static class Invoices
{
    const string InvoiceDir = "/work/data/invoices";

    public static void MapInvoices(this WebApplication app)
    {
        // /api/invoices/download?file=invoice-1001.txt
        app.MapGet("/api/invoices/download", (string file, HttpContext ctx) =>
        {
            if (Auth.User(ctx) is null) return Results.Unauthorized();
            // Path.Combine("/dir", "/etc/passwd") returns "/etc/passwd": a rooted second part wins. So resolve the
            // full path (which also removes ../) and check it is still inside the folder, separator included:
            // "/work/data/invoices-old/..." starts with "/work/data/invoices" but is a different folder.
            var root = Path.GetFullPath(InvoiceDir) + Path.DirectorySeparatorChar;
            var path = Path.GetFullPath(Path.Combine(root, file));
            if (!path.StartsWith(root, StringComparison.Ordinal)) return Results.BadRequest(new { error = "Unknown invoice." });
            if (!File.Exists(path)) return Results.NotFound();
            return Results.File(path, "text/plain");
        });
    }
}
