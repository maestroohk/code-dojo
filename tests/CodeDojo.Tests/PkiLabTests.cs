using CodeDojo;
using static CodeDojo.PkiLab;

namespace CodeDojo.Tests;

public class PkiLabTests
{
    static readonly DateTimeOffset Y2030 = new(2030, 1, 1, 0, 0, 0, TimeSpan.Zero);
    static readonly DateTimeOffset At = new(2031, 6, 1, 0, 0, 0, TimeSpan.Zero);

    static CertSpec Root(string id = "root") => new(id, "Dojo Root CA", null, true, null, Y2030, Y2030.AddYears(20), null, null);
    static CertSpec Inter(string issuer = "root", bool forged = false) => new("int", "Dojo Issuing CA", issuer, true, 0, Y2030, Y2030.AddYears(10), null, null, forged);
    static CertSpec Leaf(string issuer = "int", string[]? san = null, string? eku = "server", DateTimeOffset? end = null) =>
        new("leaf", "shop.example", issuer, false, null, Y2030, end ?? Y2030.AddYears(2), san ?? ["shop.example", "*.shop.example"], eku);

    static Response Check(CertSpec[] certs, string[] trusted, string[] sent, string? host = "shop.example") =>
        Run(new(certs, new("leaf", trusted, sent, host, At)));

    [Fact]
    public void Healthy_three_level_chain_is_valid()
    {
        var r = Check([Root(), Inter(), Leaf()], ["root"], ["int"]);
        Assert.Null(r.Error);
        Assert.True(r.Validation!.Valid, string.Join("; ", r.Validation.Problems));
        Assert.Equal(["leaf", "int", "root"], r.Validation.Chain.Select(e => e.Id));
        Assert.Contains(r.Certs, c => c.Id == "root" && c.SelfSigned && c.IsCa);
        Assert.StartsWith("-----BEGIN CERTIFICATE-----", r.Certs[0].Pem);
    }

    [Fact]
    public void Missing_intermediate_is_a_partial_chain()
    {
        var v = Check([Root(), Inter(), Leaf()], ["root"], sent: [])!.Validation!;
        Assert.False(v.Valid);
        Assert.Contains(v.Problems, p => p.Contains("intermediate"));
    }

    [Fact]
    public void Root_not_in_trust_store_is_untrusted()
    {
        var v = Check([Root(), Inter(), Leaf()], trusted: [], ["int"]).Validation!;
        Assert.False(v.Valid);
        Assert.Contains(v.Notes, n => n.Contains("trust store is empty"));
    }

    [Fact]
    public void Expired_leaf_fails_on_time()
    {
        var v = Check([Root(), Inter(), Leaf(end: Y2030.AddYears(1))], ["root"], ["int"]).Validation!;
        Assert.False(v.Valid);
        Assert.Contains(v.Problems, p => p.Contains("validity period"));
    }

    [Fact]
    public void Forged_intermediate_has_a_bad_signature()
    {
        var v = Check([Root(), Inter(forged: true), Leaf()], ["root"], ["int"]).Validation!;
        Assert.False(v.Valid);
    }

    [Theory]
    [InlineData("shop.example", true)]
    [InlineData("www.shop.example", true)]
    [InlineData("a.b.shop.example", false)]
    [InlineData("evil.example", false)]
    public void Host_must_match_a_san(string host, bool ok)
    {
        var v = Check([Root(), Inter(), Leaf()], ["root"], ["int"], host).Validation!;
        Assert.Equal(ok, v.Valid);
    }

    [Fact]
    public void Client_only_eku_is_rejected_for_a_server()
    {
        var v = Check([Root(), Inter(), Leaf(eku: "client")], ["root"], ["int"]).Validation!;
        Assert.False(v.Valid);
        Assert.Contains(v.Problems, p => p.Contains("Extended Key Usage"));
    }

    [Fact]
    public void Leaf_issuing_another_cert_breaks_basic_constraints()
    {
        var sub = new CertSpec("sub", "sub.shop.example", "leaf", false, null, Y2030, Y2030.AddYears(2), ["sub.shop.example"], "server");
        var r = Run(new([Root(), Inter(), Leaf(), sub], new("sub", ["root"], ["int", "leaf"], "sub.shop.example", At)));
        Assert.False(r.Validation!.Valid);
    }

    [Fact]
    public void Issuer_loops_and_unknown_issuers_are_reported()
    {
        var a = new CertSpec("a", "A", "b", true, null, Y2030, Y2030.AddYears(1), null, null);
        var b = new CertSpec("b", "B", "a", true, null, Y2030, Y2030.AddYears(1), null, null);
        Assert.Contains("loop", Run(new([a, b], null)).Error);
        Assert.Contains("does not exist", Run(new([Leaf(issuer: "nope")], null)).Error);
    }
}
