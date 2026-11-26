namespace Shop;

public record NewReview(long ProductId, string Body);

public static class Reviews
{
    public static void MapReviews(this WebApplication app)
    {
        app.MapPost("/api/reviews", (NewReview review, HttpContext ctx) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(review.Body) || review.Body.Length > 2000) return Results.BadRequest(new { error = "1 to 2000 characters." });
            Db.Exec("INSERT INTO reviews (product_id, user_id, body, created_at) VALUES ($p, $u, $b, datetime('now'))",
                ("$p", review.ProductId), ("$u", user.Id), ("$b", review.Body));
            var id = (long)Db.Query("SELECT max(id) AS id FROM reviews")[0]["id"]!;
            return Results.Created($"/products/{review.ProductId}#review-{id}", new { id });
        });

        // The newest review id (the staff dashboard polls it).
        app.MapGet("/api/reviews/latest", () =>
        {
            var r = Db.Query("SELECT id, product_id FROM reviews ORDER BY id DESC LIMIT 1").FirstOrDefault();
            return Results.Ok(new { id = r?["id"] ?? 0L, productId = r?["product_id"] ?? 0L });
        });
    }
}
