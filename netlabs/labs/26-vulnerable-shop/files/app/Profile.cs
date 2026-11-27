namespace Shop;

/// <summary>The profile the account page loads, edits and sends back.</summary>
public record UserProfile(long Id, string Username, string DisplayName, string Email, bool IsAdmin, string? SupportPin);

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

        // The front-end sends the profile back with its changes, and we save it.
        app.MapPut("/api/me", (UserProfile profile, HttpContext ctx) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Unauthorized();
            Db.Exec("UPDATE users SET display_name = $d, email = $e, is_admin = $a WHERE id = $id",
                ("$d", profile.DisplayName), ("$e", profile.Email), ("$a", profile.IsAdmin ? 1 : 0), ("$id", user.Id));
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
