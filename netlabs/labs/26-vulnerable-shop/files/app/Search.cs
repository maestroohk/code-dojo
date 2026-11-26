namespace Shop;

public static class Search
{
    public static void MapSearch(this WebApplication app)
    {
        // Search box on the home page: /api/products/search?q=lamp
        app.MapGet("/api/products/search", (string? q) =>
        {
            var sql = "SELECT id, name, price_cents FROM products WHERE hidden = 0 AND name LIKE '%" + (q ?? "") + "%' ORDER BY name";
            return Results.Ok(Db.Query(sql));
        });

        // Product details for the mobile app.
        app.MapGet("/api/products/{id:int}", (int id) =>
        {
            var p = Db.Query("SELECT id, name, description, price_cents FROM products WHERE id = $id AND hidden = 0", ("$id", id)).First();
            return Results.Ok(p);
        });
    }
}
