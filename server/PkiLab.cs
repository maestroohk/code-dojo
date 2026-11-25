using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace CodeDojo;

/// <summary>
/// The certificate lab. The page describes a small PKI (who issues whom, validity, SANs, flags);
/// this builds it out of real X.509 certificates and validates a chain with the real X509Chain,
/// so what the learner sees is exactly what .NET (and, roughly, a browser) would decide.
/// Stateless: every request builds fresh keys. Nothing touches the machine's certificate stores.
/// </summary>
public static class PkiLab
{
    public const int MaxCerts = 12;

    public record CertSpec(
        string Id, string Name, string? Issuer, bool Ca, int? PathLength,
        DateTimeOffset NotBefore, DateTimeOffset NotAfter,
        string[]? San, string? Eku, bool Forged = false, bool NoSki = false);

    public record ValidateSpec(string Leaf, string[]? Trusted, string[]? Sent, string? Host, DateTimeOffset? At);

    public record Request(CertSpec[] Certs, ValidateSpec? Validate);

    public record CertView(
        string Id, string Subject, string Issuer, string Serial, string Thumbprint,
        DateTimeOffset NotBefore, DateTimeOffset NotAfter, bool SelfSigned, bool IsCa, int? PathLength,
        string[] San, string[] Eku, string KeyUsage, string? Ski, string? Aki, string Pem, string Text);

    public record ChainElement(string? Id, string Subject, string[] Problems);

    public record Verdict(bool Valid, List<ChainElement> Chain, List<string> Problems, List<string> Notes);

    public record Response(List<CertView> Certs, Verdict? Validation, string? Error);

    public static Response Run(Request req)
    {
        if (req.Certs is null || req.Certs.Length == 0) return new([], null, "Add at least one certificate.");
        if (req.Certs.Length > MaxCerts) return new([], null, $"At most {MaxCerts} certificates.");
        var specs = new Dictionary<string, CertSpec>();
        foreach (var c in req.Certs)
        {
            if (string.IsNullOrWhiteSpace(c.Id) || !specs.TryAdd(c.Id, c)) return new([], null, "Every certificate needs a unique id.");
            if (string.IsNullOrWhiteSpace(c.Name) || c.Name.Length > 64) return new([], null, $"'{c.Id}' needs a name of 1 to 64 characters.");
            if (c.NotAfter <= c.NotBefore) return new([], null, $"'{c.Name}' must end after it starts.");
            if (c.Issuer is { } iss && iss != c.Id && !specs.ContainsKey(iss) && req.Certs.All(x => x.Id != iss))
                return new([], null, $"'{c.Name}' is issued by '{iss}', which does not exist.");
        }

        // Issue parents before children. A loop (A issues B issues A) cannot exist in real life either.
        var built = new Dictionary<string, X509Certificate2>();
        var order = new List<CertSpec>();
        var visiting = new HashSet<string>();
        string? cycle = null;
        void Visit(CertSpec s)
        {
            if (order.Contains(s) || cycle is not null) return;
            if (!visiting.Add(s.Id)) { cycle = s.Name; return; }
            if (s.Issuer is { } p && p != s.Id) Visit(specs[p]);
            visiting.Remove(s.Id);
            order.Add(s);
        }
        foreach (var s in specs.Values) Visit(s);
        if (cycle is not null) return new([], null, $"'{cycle}' is part of a loop of issuers. Every chain has to end at a self-signed root.");

        try
        {
            foreach (var s in order) built[s.Id] = Issue(s, s.Issuer is { } p && p != s.Id ? (built[p], specs[p]) : null);
            var views = order.Select(s => View(s, built[s.Id])).ToList();
            var verdict = req.Validate is { } v ? Validate(v, built, specs) : null;
            return new(views, verdict, null);
        }
        catch (Exception e) when (e is CryptographicException or ArgumentException)
        {
            return new([], null, "Could not build the certificates: " + e.Message);
        }
        finally
        {
            foreach (var c in built.Values) c.Dispose();
        }
    }

    static X509Certificate2 Issue(CertSpec s, (X509Certificate2 Cert, CertSpec Spec)? issuer)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var dn = new X500DistinguishedName("CN=" + s.Name.Replace(",", " ").Replace("=", " ").Replace("+", " "));
        var req = new CertificateRequest(dn, key, HashAlgorithmName.SHA256);

        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(s.Ca, s.Ca && s.PathLength is not null, s.PathLength ?? 0, true));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(
            s.Ca ? X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign : X509KeyUsageFlags.DigitalSignature, true));
        if (!s.NoSki) req.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(req.PublicKey, false));
        if (s.San is { Length: > 0 })
        {
            var san = new SubjectAlternativeNameBuilder();
            foreach (var name in s.San.Where(n => !string.IsNullOrWhiteSpace(n)).Take(10)) san.AddDnsName(name.Trim());
            req.CertificateExtensions.Add(san.Build());
        }
        var ekuOid = s.Eku switch { "server" => "1.3.6.1.5.5.7.3.1", "client" => "1.3.6.1.5.5.7.3.2", _ => null };
        if (ekuOid is not null) req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid(ekuOid)], false));

        if (issuer is null)
            return req.CreateSelfSigned(s.NotBefore, s.NotAfter);

        var (parent, parentSpec) = issuer.Value;
        var serial = RandomNumberGenerator.GetBytes(12);
        serial[0] &= 0x7f;

        if (!s.NoSki && parentSpec is { NoSki: false })
            req.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromCertificate(parent, true, false));

        // Sign through a raw generator, not req.Create(parent, ...): that overload refuses issuers that
        // are not CAs and children that outlive their issuer. The lab must be able to make those mistakes
        // so the learner can watch validation catch them.
        // A forged certificate names the real issuer but is signed by an impostor's key.
        using var fakeKey = s.Forged ? ECDsa.Create(ECCurve.NamedCurves.nistP256) : null;
        using var parentKey = parent.GetECDsaPrivateKey()!;
        var signer = X509SignatureGenerator.CreateForECDsa(fakeKey ?? parentKey);
        using var cert = req.Create(parent.SubjectName, signer, s.NotBefore, s.NotAfter, serial);
        return cert.CopyWithPrivateKey(key);
    }

    static CertView View(CertSpec s, X509Certificate2 c)
    {
        var bc = c.Extensions.OfType<X509BasicConstraintsExtension>().FirstOrDefault();
        var san = c.Extensions.OfType<X509SubjectAlternativeNameExtension>().FirstOrDefault()?.EnumerateDnsNames().ToArray() ?? [];
        var eku = c.Extensions.OfType<X509EnhancedKeyUsageExtension>().FirstOrDefault()?.EnhancedKeyUsages
            .Cast<Oid>().Select(o => o.FriendlyName ?? o.Value ?? "").ToArray() ?? [];
        var ku = c.Extensions.OfType<X509KeyUsageExtension>().FirstOrDefault()?.KeyUsages.ToString() ?? "";
        var ski = c.Extensions.OfType<X509SubjectKeyIdentifierExtension>().FirstOrDefault()?.SubjectKeyIdentifier;
        var aki = c.Extensions.OfType<X509AuthorityKeyIdentifierExtension>().FirstOrDefault()?.KeyIdentifier is { } k
            ? Convert.ToHexString(k.Span) : null;
        var pathLen = bc is { CertificateAuthority: true, HasPathLengthConstraint: true } ? bc.PathLengthConstraint : (int?)null;

        var text = new StringBuilder();
        text.AppendLine("Certificate:");
        text.AppendLine($"    Serial Number: {Colons(c.SerialNumber)}");
        text.AppendLine("    Signature Algorithm: ecdsa-with-SHA256");
        text.AppendLine($"    Issuer: {c.Issuer}");
        text.AppendLine("    Validity");
        text.AppendLine($"        Not Before: {c.NotBefore.ToUniversalTime():yyyy-MM-dd HH:mm} UTC");
        text.AppendLine($"        Not After : {c.NotAfter.ToUniversalTime():yyyy-MM-dd HH:mm} UTC");
        text.AppendLine($"    Subject: {c.Subject}");
        text.AppendLine("    Subject Public Key Info: id-ecPublicKey (P-256)");
        text.AppendLine("    X509v3 extensions:");
        text.AppendLine($"        Basic Constraints: critical");
        text.AppendLine($"            CA:{(bc?.CertificateAuthority == true ? "TRUE" : "FALSE")}{(pathLen is { } pl ? $", pathlen:{pl}" : "")}");
        text.AppendLine($"        Key Usage: critical");
        text.AppendLine($"            {ku}");
        if (eku.Length > 0) { text.AppendLine("        Extended Key Usage:"); text.AppendLine($"            {string.Join(", ", eku)}"); }
        if (ski is not null) { text.AppendLine("        Subject Key Identifier:"); text.AppendLine($"            {Colons(ski)}"); }
        if (aki is not null) { text.AppendLine("        Authority Key Identifier:"); text.AppendLine($"            {Colons(aki)}"); }
        if (san.Length > 0) { text.AppendLine("        Subject Alternative Name:"); text.AppendLine($"            {string.Join(", ", san.Select(n => "DNS:" + n))}"); }
        text.AppendLine($"    SHA-1 Thumbprint: {Colons(c.Thumbprint)}");

        return new(s.Id, c.Subject, c.Issuer, c.SerialNumber, c.Thumbprint,
            c.NotBefore.ToUniversalTime(), c.NotAfter.ToUniversalTime(), c.SubjectName.RawData.AsSpan().SequenceEqual(c.IssuerName.RawData),
            bc?.CertificateAuthority == true, pathLen, san, eku, ku, ski, aki, c.ExportCertificatePem(), text.ToString());
    }

    static string Colons(string hex) => string.Join(":", Enumerable.Range(0, hex.Length / 2).Select(i => hex.Substring(i * 2, 2)));

    static Verdict Validate(ValidateSpec v, Dictionary<string, X509Certificate2> built, Dictionary<string, CertSpec> specs)
    {
        var notes = new List<string>();
        var problems = new List<string>();
        if (!built.TryGetValue(v.Leaf ?? "", out var leaf))
            return new(false, [], ["Pick the certificate to check."], notes);

        using var chain = new X509Chain();
        var p = chain.ChainPolicy;
        p.TrustMode = X509ChainTrustMode.CustomRootTrust;
        p.RevocationMode = X509RevocationMode.NoCheck;
        p.DisableCertificateDownloads = true;
        p.VerificationTime = (v.At ?? DateTimeOffset.UtcNow).UtcDateTime;
        p.VerificationTimeIgnored = false;
        foreach (var id in v.Trusted ?? []) if (built.TryGetValue(id, out var t)) p.CustomTrustStore.Add(t);
        foreach (var id in v.Sent ?? []) if (id != v.Leaf && built.TryGetValue(id, out var x)) p.ExtraStore.Add(x);

        if (p.CustomTrustStore.Count == 0) notes.Add("Your trust store is empty, so nothing can be trusted. Tick at least one root under \"Trusted roots\".");

        var ok = chain.Build(leaf);
        var byThumb = built.ToDictionary(kv => kv.Value.Thumbprint, kv => kv.Key);
        var elements = chain.ChainElements.Select(e => new ChainElement(
            byThumb.GetValueOrDefault(e.Certificate.Thumbprint),
            e.Certificate.GetNameInfo(X509NameType.SimpleName, false),
            e.ChainElementStatus.Where(st => st.Status != X509ChainStatusFlags.NoError)
                .Select(st => Explain(st.Status, e.Certificate)).Distinct().ToArray())).ToList();

        foreach (var st in chain.ChainStatus.Where(st => st.Status != X509ChainStatusFlags.NoError))
            problems.Add(Explain(st.Status, null));

        // Things X509Chain leaves to the caller (TLS does these on top of the chain).
        var leafSpec = specs[v.Leaf!];
        if (!string.IsNullOrWhiteSpace(v.Host))
        {
            var host = v.Host.Trim().ToLowerInvariant();
            var names = leafSpec.San?.Where(n => !string.IsNullOrWhiteSpace(n)).Select(n => n.Trim().ToLowerInvariant()).ToArray() ?? [];
            if (names.Length == 0)
            {
                problems.Add($"Name mismatch: the certificate has no Subject Alternative Name, so it is valid for no host name. Clients ignore the CN (\"{leafSpec.Name}\") today.");
                ok = false;
            }
            else if (!names.Any(n => HostMatches(n, host)))
            {
                problems.Add($"Name mismatch: you connected to \"{host}\" but the certificate is only for {string.Join(", ", names)}.");
                ok = false;
            }
            else notes.Add($"\"{host}\" matches the certificate's SAN list.");

            if (leafSpec.Eku is "client")
            {
                problems.Add("Wrong purpose: this certificate's Extended Key Usage says client authentication only, so a TLS client will not accept it as a server certificate.");
                ok = false;
            }
        }
        if (leafSpec.Ca) notes.Add("You are checking a CA certificate as if it were a server's. That is unusual: servers present leaf certificates (CA:FALSE).");

        var chainIds = elements.Select(e => e.Id).ToHashSet();
        foreach (var id in v.Sent ?? [])
            if (id != v.Leaf && !chainIds.Contains(id) && specs.TryGetValue(id, out var sent))
                notes.Add($"'{sent.Name}' was sent but is not part of this chain, so it was ignored.");
        if (ok) notes.Add("Every signature checks out, from the certificate up to a root in your trust store.");

        return new(ok, elements, problems.Distinct().ToList(), notes);
    }

    static bool HostMatches(string pattern, string host)
    {
        if (pattern == host) return true;
        // A wildcard covers exactly one label: *.example.com matches a.example.com, not a.b.example.com or example.com.
        if (!pattern.StartsWith("*.")) return false;
        var dot = host.IndexOf('.');
        return dot > 0 && host[(dot + 1)..] == pattern[2..];
    }

    static string Explain(X509ChainStatusFlags flag, X509Certificate2? cert)
    {
        var who = cert is null ? "" : $"\"{cert.GetNameInfo(X509NameType.SimpleName, false)}\": ";
        return who + flag switch
        {
            X509ChainStatusFlags.NotTimeValid => "outside its validity period at the time you checked (expired, or not valid yet).",
            X509ChainStatusFlags.UntrustedRoot => "the chain ends at a root that is not in your trust store.",
            X509ChainStatusFlags.PartialChain => "the chain could not be completed: an issuer is missing. Usually the server forgot to send an intermediate.",
            X509ChainStatusFlags.NotSignatureValid => "the signature does not verify. It claims an issuer whose key did not sign it (a forgery, or a re-issued CA).",
            X509ChainStatusFlags.InvalidBasicConstraints => "issued certificates without being a CA (CA:FALSE), or broke a path length limit.",
            X509ChainStatusFlags.NotValidForUsage => "is not allowed for this purpose (Key Usage or Extended Key Usage).",
            X509ChainStatusFlags.Cyclic => "the chain loops back on itself.",
            X509ChainStatusFlags.InvalidExtension => "has an invalid extension.",
            X509ChainStatusFlags.RevocationStatusUnknown or X509ChainStatusFlags.OfflineRevocation => "revocation could not be checked.",
            X509ChainStatusFlags.Revoked => "has been revoked.",
            _ => flag.ToString() + ".",
        };
    }
}
