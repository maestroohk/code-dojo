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

        // One order, with its delivery details. Ownership is part of the lookup: someone else's order
        // looks exactly like one that does not exist (404), so ids cannot be probed.
        app.MapGet("/api/orders/{id:int}", (int id, HttpContext ctx) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Unauthorized();
            var order = Db.Query(
                "SELECT id, user_id, placed_at, total_cents, status, ship_to, delivery_note FROM orders WHERE id = $id AND user_id = $u",
                ("$id", id), ("$u", user.Id)).FirstOrDefault();
            return order is null ? Results.NotFound() : Results.Ok(order);
        });
    }
}
