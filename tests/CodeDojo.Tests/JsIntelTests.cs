using CodeDojo;
using static CodeDojo.CodeIntel;

namespace CodeDojo.Tests;

/// <summary>JavaScript / TypeScript intelligence (server/JsIntel*.cs): no Node needed.</summary>
public class JsIntelTests
{
    static readonly CSharpRunner Runner = new();

    static Response Ask(string action, string code, string path = "main.ts", params FileText[] more)
    {
        var pos = code.IndexOf("$$", StringComparison.Ordinal);
        Assert.True(pos >= 0, "marker $$ not found");
        var lang = path.EndsWith(".ts") ? "typescript" : "javascript";
        return RunAny(Runner, new(action, [new(path, code.Replace("$$", "")), .. more], path, pos, null, lang)).GetAwaiter().GetResult();
    }

    static List<string> Labels(Response r) => r.Items?.Select(i => i.Label).ToList() ?? [];

    static readonly FileText Geo = new("geo.ts", """
        /** Area of a circle. */
        export function area(r: number): number {
          return Math.PI * r * r;
        }

        export class Shape {
          constructor(public name: string) {}
          describe(): string { return this.name; }
        }

        export const UNIT = "cm";
        """);

    [Fact]
    public void Completes_string_members_of_a_literal()
    {
        var labels = Labels(Ask("complete", "const s = \"text\".$$", "main.js"));
        Assert.Contains("toUpperCase", labels);
        Assert.Contains("split", labels);
        Assert.DoesNotContain("push", labels);
    }

    [Fact]
    public void Completes_members_of_a_user_class()
    {
        var r = Ask("complete", """
            class Point {
              constructor(x, y) { this.x = x; this.y = y; }
              length() { return Math.hypot(this.x, this.y); }
              static origin() { return new Point(0, 0); }
            }
            const p = new Point(3, 4);
            p.$$
            """, "main.js");
        var labels = Labels(r);
        Assert.Contains("x", labels);
        Assert.Contains("length", labels);
        Assert.DoesNotContain("origin", labels);       // static, not on an instance
        Assert.DoesNotContain("constructor", labels);
        Assert.Contains(r.Items!, i => i.Label == "length" && i.Kind == "method");
        Assert.Contains("origin", Labels(Ask("complete", "class Point { static origin() { return 1; } }\nPoint.$$", "main.js")));
    }

    [Fact]
    public void Completes_object_literal_members_and_chains_through_builtins()
    {
        Assert.Equal(["name", "age", "greet"], Labels(Ask("complete", "const user = { name: 'ann', age: 3, greet() { return 'hi'; } };\nuser.$$", "main.js")));
        Assert.Contains("toUpperCase", Labels(Ask("complete", "const user = { name: 'ann' };\nuser.name.$$", "main.js")));
        Assert.Contains("map", Labels(Ask("complete", "const words = 'a b'.split(' ');\nwords.$$", "main.js")));
        Assert.Contains("join", Labels(Ask("complete", "const xs = [1, 2].map(n => n * 2).filter(n => n > 2);\nxs.$$", "main.js")));
        Assert.Contains("log", Labels(Ask("complete", "console.$$", "main.js")));
        Assert.Contains("classList", Labels(Ask("complete", "const el = document.querySelector('#x');\nel.$$", "main.js")));
    }

    [Fact]
    public void Completes_members_from_type_annotations()
    {
        var code = """
            interface Student { name: string; score: number; }
            function best(list: Student[]): Student {
              return list[0];
            }
            const top = best([]);
            top.$$
            """;
        Assert.Equal(["name", "score"], Labels(Ask("complete", code)));
        Assert.Contains("reduce", Labels(Ask("complete", "function f(list: Student[]) {\n  list.$$\n}")));
        Assert.Contains("toFixed", Labels(Ask("complete", "let n: number = 1;\nn.$$")));
        // Arrays remember what they hold: indexing, find() and filter() keep the element type.
        Assert.Equal(["name", "score"], Labels(Ask("complete", "interface Student { name: string; score: number; }\nconst list: Student[] = [];\nlist[0].$$")));
        Assert.Equal(["name", "score"], Labels(Ask("complete", "interface Student { name: string; score: number; }\nfunction f(list: Array<Student>) {\n  list.filter(s => s.score > 1).find(s => true).$$\n}")));
        Assert.Contains("x", Labels(Ask("complete", "class P { x = 1 }\nconst ps = [new P()];\nps[0].$$", "main.js")));
    }

    [Fact]
    public void Completes_names_in_scope_keywords_and_globals()
    {
        var r = Ask("complete", """
            const total = 1;
            function run(count) {
              const local = count + 1;
              lo$$
            }
            """, "main.js");
        Assert.Contains(r.Items!, i => i.Label == "local" && i.Kind == "variable");
        Assert.Contains(r.Items!, i => i.Label == "count" && i.Kind == "parameter");
        Assert.Contains(r.Items!, i => i.Label == "run" && i.Kind == "function");
        Assert.Contains(r.Items!, i => i.Label == "console");
        Assert.Contains(r.Items!, i => i.Label == "return" && i.Kind == "keyword");
        Assert.DoesNotContain(r.Items!, i => i.Label == "interface");   // TypeScript only
        var outside = Labels(Ask("complete", "function run(count) { const local = 1; }\nlo$$", "main.js"));
        Assert.DoesNotContain("local", outside);
        Assert.DoesNotContain("count", outside);
    }

    [Fact]
    public void Completes_exports_of_another_file()
    {
        var labels = Labels(Ask("complete", "import * as geo from './geo';\ngeo.$$", "main.ts", Geo));
        Assert.Equal(["area", "Shape", "UNIT"], labels);
        Assert.Contains("describe", Labels(Ask("complete", "import { Shape } from './geo';\nconst s = new Shape('sq');\ns.$$", "main.ts", Geo)));
        Assert.Contains("area", Labels(Ask("complete", "import { ar$$ } from './geo';", "main.ts", Geo)));
    }

    [Fact]
    public void No_completion_inside_strings_or_comments()
    {
        Assert.Empty(Labels(Ask("complete", "const s = 'abc.$$'", "main.js")));
        Assert.Empty(Labels(Ask("complete", "// x.$$", "main.js")));
    }

    [Fact]
    public void Goes_to_a_definition_in_the_same_file()
    {
        var r = Ask("definition", "const rate = 0.2;\nfunction tax(amount) {\n  return amount * ra$$te;\n}", "main.js");
        Assert.Equal(("main.js", 1, 7), (r.Definition!.Path, r.Definition.Line, r.Definition.Column));
        var param = Ask("definition", "const amount = 5;\nconst tax = (amount) => amount$$ * 2;", "main.js");
        Assert.Equal((2, 14), (param.Definition!.Line, param.Definition.Column));
        var member = Ask("definition", "class A {\n  go() {}\n  run() { this.g$$o(); }\n}", "main.js");
        Assert.Equal((2, 3), (member.Definition!.Line, member.Definition.Column));
    }

    [Fact]
    public void Goes_to_a_definition_in_another_file()
    {
        var r = Ask("definition", "import { area } from './geo';\nconsole.log(ar$$ea(2));", "main.ts", Geo);
        Assert.Equal(("geo.ts", 2, 17), (r.Definition!.Path, r.Definition.Line, r.Definition.Column));
        var method = Ask("definition", "import { Shape } from './geo';\nnew Shape('x').desc$$ribe();", "main.ts", Geo);
        Assert.Equal(("geo.ts", 8), (method.Definition!.Path, method.Definition.Line));
        var cjs = Ask("definition", "const { helper } = require('./util');\nhel$$per();", "main.js",
            new FileText("util.js", "function helper() {}\nmodule.exports = { helper };\n"));
        Assert.Equal(("util.js", 1, 10), (cjs.Definition!.Path, cjs.Definition.Line, cjs.Definition.Column));
    }

    [Fact]
    public void Built_ins_are_described_instead()
    {
        var r = Ask("definition", "console.lo$$g(1);", "main.js");
        Assert.Null(r.Definition);
        Assert.Contains("console.log(", r.External);
        Assert.Contains("no source to open", r.External);
    }

    [Fact]
    public void Finds_references_scope_aware_and_across_files()
    {
        var local = Ask("references", "const x = 1;\nfunction f(x) {\n  return x$$ + 1;\n}\nconsole.log(x);", "main.js");
        Assert.Equal([2, 3], local.References!.Select(l => l.Line));
        var shadowed = Ask("references", "const x$$ = 1;\nfunction f(x) {\n  return x + 1;\n}\nconsole.log(x);", "main.js");
        Assert.Equal([1, 5], shadowed.References!.Select(l => l.Line));
        var across = Ask("references", "import { area } from './geo';\nconst a = ar$$ea(1);\nconst b = area(2);", "main.ts", Geo);
        Assert.Equal(["main.ts:1", "main.ts:2", "main.ts:3", "geo.ts:2"], across.References!.Select(l => $"{l.Path}:{l.Line}"));
        var field = Ask("references", "class C {\n  constructor() { this.n = 0; }\n  inc() { this.n$$++; }\n}\nnew C().n;", "main.js");
        Assert.Equal([2, 3, 5], field.References!.Select(l => l.Line));
    }

    [Fact]
    public void Hover_shows_declarations_with_types()
    {
        Assert.Equal("(function) function area(r: number): number\nArea of a circle.", Ask("hover", "import { area } from './geo';\nar$$ea(1);", "main.ts", Geo).Hover);
        Assert.StartsWith("(const) p: Point", Ask("hover", "class Point {}\nconst p$$ = new Point();", "main.js").Hover);
        Assert.StartsWith("(let) total: number", Ask("hover", "let tot$$al: number = 0;").Hover);
        Assert.StartsWith("(const) names: string[]", Ask("hover", "const nam$$es = 'a,b'.split(',');", "main.js").Hover!.Replace("any[]", "string[]"));
        Assert.Equal("(property) Shape.name: string", Ask("hover", "import { Shape } from './geo';\nnew Shape('x').na$$me;", "main.ts", Geo).Hover);
        Assert.Equal("(interface) interface Student", Ask("hover", "interface Student { name: string }\nlet s: Stud$$ent;").Hover);
    }

    [Fact]
    public void Understands_destructuring_enums_and_types()
    {
        var r = Ask("definition", "const { a, b: [c] } = obj;\nconsole.log(c$$);", "main.js");
        Assert.Equal((1, 16), (r.Definition!.Line, r.Definition.Column));
        Assert.Equal(["Red", "Green"], Labels(Ask("complete", "enum Color { Red, Green = 2 }\nColor.$$")));
        Assert.Equal(["x", "y"], Labels(Ask("complete", "type P = { x: number; y: number };\nconst p: P = { x: 1, y: 2 };\np.$$")));
    }
}
