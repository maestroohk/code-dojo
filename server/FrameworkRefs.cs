using System.Collections.Concurrent;
using System.Reflection.PortableExecutable;
using Microsoft.CodeAnalysis;

namespace CodeDojo;

/// <summary>
/// Compiler references for a shared framework (Microsoft.NETCore.App, Microsoft.AspNetCore.App): every
/// managed assembly in its folder.
///
/// Taking them from this process's loaded-assembly list (TRUSTED_PLATFORM_ASSEMBLIES) filtered by folder
/// misses any assembly a NuGet package also ships. The host then loads the package's copy from its own
/// folder, so the framework copy is not on the list. In the test host that dropped
/// Microsoft.Extensions.Primitives, and every web exercise failed with CS0012. Reading the folder does not
/// depend on what the host loaded.
/// </summary>
public static class FrameworkRefs
{
    static readonly ConcurrentDictionary<string, List<string>> Files = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The managed assemblies in a framework folder (native DLLs such as coreclr.dll are left out).</summary>
    public static List<string> Paths(string dir) => Files.GetOrAdd(dir, d =>
        Directory.GetFiles(d, "*.dll").Where(IsManaged).Order(StringComparer.OrdinalIgnoreCase).ToList());

    public static List<MetadataReference> In(string dir) =>
        Paths(dir).Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();

    static bool IsManaged(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            using var pe = new PEReader(stream);
            return pe.HasMetadata;
        }
        catch { return false; }
    }
}
