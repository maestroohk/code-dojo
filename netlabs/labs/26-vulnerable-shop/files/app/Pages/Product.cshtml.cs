using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace Shop.Pages;

public record ReviewView(long Id, string Author, string Body, string Date);

public class ProductModel : PageModel
{
    public long Id { get; private set; }
    public string Name { get; private set; } = "";
    public string Description { get; private set; } = "";
    public string Price { get; private set; } = "";
    public List<ReviewView> Reviews { get; private set; } = [];
    public string? SignedInAs { get; private set; }

    public IActionResult OnGet(int id)
    {
        var p = Db.Query("SELECT id, name, description, price_cents FROM products WHERE id = $id AND hidden = 0", ("$id", id)).FirstOrDefault();
        if (p is null) return NotFound();
        Id = (long)p["id"]!;
        Name = (string)p["name"]!;
        Description = (string)p["description"]!;
        Price = $"{(long)p["price_cents"]! / 100.0:0.00} EUR";
        Reviews = Db.Query(
            "SELECT r.id, u.display_name, r.body, r.created_at FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.product_id = $p ORDER BY r.id",
            ("$p", id)).Select(r => new ReviewView((long)r["id"]!, (string)r["display_name"]!, (string)r["body"]!, (string)r["created_at"]!)).ToList();
        SignedInAs = Auth.User(HttpContext)?.Username;
        return Page();
    }
}
