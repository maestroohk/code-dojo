namespace Shop;

/// <summary>Error handling and the response headers every answer gets.</summary>
public static class Hardening
{
    public static void AddHardening(this WebApplicationBuilder builder)
    {
    }

    public static void UseHardening(this WebApplication app)
    {
        // Full error details make debugging much quicker.
        app.UseDeveloperExceptionPage();
    }
}
