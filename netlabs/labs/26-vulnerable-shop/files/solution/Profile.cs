namespace Shop;

/// <summary>The profile the account page loads (what the server says).</summary>
public record UserProfile(long Id, string Username, string DisplayName, string Email, bool IsAdmin, string? SupportPin);

/// <summary>What a customer may change about themselves. Nothing else can be bound from the request.</summary>
public record ProfileUpdate(string DisplayName, string Email);

public static class Profile
{
    public static void MapProfile(this WebApplication app)
    {
        app.MapGet("/api/me", (HttpContext ctx) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Unauthorized();
            return Results.Ok(Load(user.Id));
        });

        // Bind an input DTO, not the entity: extra fields in the body (isAdmin, id, supportPin) are ignored.
        app.MapPut("/api/me", (ProfileUpdate update, HttpContext ctx) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(update.DisplayName) || !update.Email.Contains('@'))
                return Results.BadRequest(new { error = "A display name and an email address are required." });
            Db.Exec("UPDATE users SET display_name = $d, email = $e WHERE id = $id",
                ("$d", update.DisplayName), ("$e", update.Email), ("$id", user.Id));
            return Results.Ok(Load(user.Id));
        });
    }

    static UserProfile Load(long id)
    {
        var r = Db.Query("SELECT id, username, display_name, email, is_admin, support_pin FROM users WHERE id = $id", ("$id", id))[0];
        return new UserProfile((long)r["id"]!, (string)r["username"]!, (string)r["display_name"]!, (string)r["email"]!,
            (long)r["is_admin"]! == 1, (string?)r["support_pin"]);
    }
}
