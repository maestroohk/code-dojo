namespace Shop;

/// <summary>The session cookie. Its value is a random token that points at a row in the sessions table.</summary>
public static class Session
{
    public const string CookieName = "sid";

    public static CookieOptions CookieOptions() => new()
    {
        Path = "/",
        HttpOnly = true,                 // page scripts (and so XSS payloads) cannot read it
        SameSite = SameSiteMode.Lax,     // not sent on cross-site POSTs, fetches or images
        // Secure = true in production: the lab has no HTTPS, and a Secure cookie is never sent over plain HTTP.
        // With HTTPS, name it "__Host-sid": browsers then insist on Secure, Path=/ and no Domain.
    };
}
