using CodeDojo;
using static CodeDojo.CodeIntel;

namespace CodeDojo.Tests;

/// <summary>
/// JavaScript / TypeScript intelligence from TypeScript's own LanguageService (server/TsIntel.cs, intel/tsintel.js).
/// Each test is skipped when Node or the typescript package is not there yet (asking starts the one-time install
/// in the background, so a later run has it). JsIntelTests covers the fallback analyser.
/// </summary>
[Collection("TypeScript intel")]
public class TsIntelTests
{
    // The first answer loads lib.d.ts; later ones are quick. Tests wait longer than the editor does.
    static readonly TimeSpan Patient = TimeSpan.FromSeconds(90);

    static bool Ready(string? dir = null) => CodeSpaces.NodeExe() is not null && TsIntel.TypeScriptFor(dir) is not null;

    static async Task<Response> Ask(string action, string code, string path = "main.ts", string? dir = null, params FileText[] more)
    {
        var pos = code.IndexOf("$$", StringComparison.Ordinal);
        Assert.True(pos >= 0, "marker $$ not found");
        var lang = path.EndsWith(".js") ? "javascript" : "typescript";
        var r = await TsIntel.Run(new(action, [new(path, code.Replace("$$", "")), .. more], path, pos, null, lang), dir, Patient);
        Assert.NotNull(r);
        Assert.Equal("typescript", r!.Engine);
        return r;
    }

    static List<string> Labels(Response r) => r.Items?.Select(i => i.Label).ToList() ?? [];

    static readonly FileText Geo = new("geo.ts", """
        /** Area of a circle. */
        export function area(r: number): number {
          return Math.PI * r * r;
        }

        export const UNIT = "cm";
        """);

    [Fact]
    public async Task Completes_members_from_lib_d_ts()
    {
        if (!Ready()) return;
        var r = await Ask("complete", "const doubled = [1, 2].ma$$");
        Assert.Contains("map", Labels(r));
        Assert.DoesNotContain("push", Labels(r));    // the typed prefix already rules it out
        var map = r.Items!.First(i => i.Label == "map");
        Assert.Equal("method", map.Kind);
        Assert.Contains("callbackfn", map.Detail);
    }

    [Fact]
    public async Task Completes_in_plain_javascript_too()
    {
        if (!Ready()) return;
        var r = await Ask("complete", "const s = 'text';\ns.toUp$$", "main.js");
        Assert.Contains("toUpperCase", Labels(r));
    }

    [Fact]
    public async Task Goes_to_a_definition_in_another_file()
    {
        if (!Ready()) return;
        var r = await Ask("definition", "import { area } from './geo';\nconsole.log(ar$$ea(2));", more: Geo);
        Assert.NotNull(r.Definition);
        Assert.Equal("geo.ts", r.Definition!.Path);
        Assert.Equal(2, r.Definition.Line);
        Assert.Equal("area".Length, r.Definition.Length);
        Assert.Contains("export function area", r.Definition.Preview);
    }

    [Fact]
    public async Task Finds_references_across_files()
    {
        if (!Ready()) return;
        var r = await Ask("references", "import { area } from './geo';\nconst a = ar$$ea(1) + area(2);", more: Geo);
        var refs = r.References!;
        Assert.Contains(refs, l => l.Path == "geo.ts" && l.Line == 2);
        Assert.Equal(3, refs.Count(l => l.Path == "main.ts"));   // the import and both calls
        Assert.Equal("main.ts", refs[0].Path);                    // the open file first
    }

    [Fact]
    public async Task Hover_shows_the_inferred_type()
    {
        if (!Ready()) return;
        var r = await Ask("hover", "const total = [1, 2].map(n => n * 2);\nconsole.log(to$$tal);");
        Assert.Contains("const total: number[]", r.Hover);
    }

    [Fact]
    public async Task Hover_includes_the_doc_comment()
    {
        if (!Ready()) return;
        var r = await Ask("hover", "import { area } from './geo';\nar$$ea(2);", more: Geo);
        Assert.Contains("area(r: number): number", r.Hover);
        Assert.Contains("Area of a circle.", r.Hover);
    }

    [Fact]
    public async Task Library_definitions_are_external()
    {
        if (!Ready()) return;
        var r = await Ask("definition", "[1, 2].ma$$p(x => x);");
        Assert.Null(r.Definition);
        Assert.Contains("Declared in the built-in types (lib.es5.d.ts)", r.External);
    }

    [Fact]
    public async Task Types_from_a_code_space_node_modules_resolve()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dojo-ts-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            // A React-like package: only its .d.ts, as @types/react ships.
            var pkg = Path.Combine(dir, "node_modules", "react");
            Directory.CreateDirectory(pkg);
            File.WriteAllText(Path.Combine(pkg, "package.json"), """{ "name": "react", "version": "19.0.0", "types": "index.d.ts" }""");
            File.WriteAllText(Path.Combine(pkg, "index.d.ts"), """
                export type SetStateAction<S> = S | ((prev: S) => S);
                export type Dispatch<A> = (value: A) => void;
                /** Returns a stateful value, and a function to update it. */
                export function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
                """);
            if (!Ready(dir)) return;

            var setter = await Ask("complete", "import { useState } from 'react';\nuseState(0)[1].$$", "app.tsx", dir);
            Assert.Contains("call", Labels(setter));    // a function: call, apply, bind
            Assert.Contains("bind", Labels(setter));

            var value = await Ask("complete", "import { useState } from 'react';\nconst [count] = useState(0);\ncount.toFi$$", "app.tsx", dir);
            Assert.Contains("toFixed", Labels(value));   // count is a number

            var hover = await Ask("hover", "import { useState } from 'react';\nconst [count, setCount] = useState(0);\nsetCo$$unt(1);", "app.tsx", dir);
            Assert.Contains("const setCount: (value: SetStateAction<number>) => void", hover.Hover);

            var def = await Ask("definition", "import { useState } from 'react';\nuseSt$$ate(0);", "app.tsx", dir);
            Assert.Null(def.Definition);
            Assert.Contains("Declared in react", def.External);
            Assert.Contains("Returns a stateful value", def.External);
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }

    [Fact]
    public async Task No_typescript_means_no_answer_so_the_caller_falls_back()
    {
        if (CodeSpaces.NodeExe() is null) return;
        var missing = Path.Combine(Path.GetTempPath(), "dojo-no-typescript-here");
        var r = await TsIntel.Run(new("complete", [new("main.ts", "[1].ma")], "main.ts", 6, null, "typescript"), null, Patient, missing);
        Assert.Null(r);
        // The editor's endpoint still answers through JsIntel.
        var basic = await RunAny(new CSharpRunner(), new("complete", [new("main.ts", "[1].ma")], "main.ts", 6, null, "typescript", Engine: "basic"));
        Assert.Contains("map", basic.Items!.Select(i => i.Label));
        Assert.Equal("basic", basic.Engine);
    }
}
