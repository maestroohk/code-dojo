namespace Shop;

public static class Orders
{
    public static void MapOrders(this WebApplication app)
    {
        // The signed-in customer's orders.
        app.MapGet("/api/orders", (HttpContext ctx) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Unauthorized();
            return Results.Ok(Db.Query(
                "SELECT id, placed_at, total_cents, status FROM orders WHERE user_id = $u ORDER BY id",
                ("$u", user.Id)));
        });

        // One order, with its delivery details. The order page in the browser calls this.
        app.MapGet("/api/orders/{id:int}", (int id, HttpContext ctx) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Unauthorized();
            var order = Db.Query(
                "SELECT id, user_id, placed_at, total_cents, status, ship_to, delivery_note FROM orders WHERE id = $id",
                ("$id", id)).FirstOrDefault();
            return order is null ? Results.NotFound() : Results.Ok(order);
        });
    }
}
