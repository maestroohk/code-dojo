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
            var path = Path.Combine(InvoiceDir, file);
            if (!File.Exists(path)) return Results.NotFound();
            return Results.File(path, "text/plain");
        });
    }
}
