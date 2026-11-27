// Lamp Shop: a small online shop. Each feature lives in its own file; this file only wires them up.
using Shop;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorPages();
builder.AddHardening();     // Hardening.cs
builder.AddAuth();          // Auth.cs
builder.AddAccount();       // Account.cs
builder.AddPreview();       // Preview.cs

var app = builder.Build();

app.UseHardening();                  // Hardening.cs
app.UseContentSecurityPolicy();      // Csp.cs
app.UseStaticFiles();

app.MapHome();          // Home.cs: /
app.MapAuth();          // Auth.cs: /login, /logout, /register
app.MapProfile();       // Profile.cs: /api/me
app.MapOrders();        // Orders.cs: /api/orders
app.MapSearch();        // Search.cs: /api/products
app.MapReviews();       // Reviews.cs: /api/reviews (the page is Pages/Product.cshtml)
app.MapAccount();       // Account.cs: /account
app.MapPreview();       // Preview.cs: /api/preview
app.MapInvoices();      // Invoices.cs: /api/invoices
app.MapTools();         // Tools.cs: /api/tools
app.MapSupport();       // Support.cs: /api/support
app.MapCheckout();      // Checkout.cs: /api/checkout
app.MapRazorPages();

app.Run();
