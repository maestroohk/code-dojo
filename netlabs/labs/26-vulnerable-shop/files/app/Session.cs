namespace Shop;

/// <summary>The session cookie. Its value is a random token that points at a row in the sessions table.</summary>
public static class Session
{
    public const string CookieName = "sid";

    public static CookieOptions CookieOptions() => new()
    {
        Path = "/",
    };
}
