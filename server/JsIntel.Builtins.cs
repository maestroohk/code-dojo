namespace CodeDojo;

public static partial class JsIntel
{
    /// <summary>A member of a built-in: Kind is method, property, function or class; Ret names the built-in type it gives back.</summary>
    sealed record Member(string Name, string Kind, string Sig, string? Ret, string? Doc = null);

    // name(params): returns   or   name: type      (one per line; "## doc" lines attach to the line before)
    static readonly Dictionary<string, string> BuiltinSource = new()
    {
        ["String"] = """
            length: number
            at(index: number): string
            charAt(index: number): string
            charCodeAt(index: number): number
            codePointAt(index: number): number
            concat(...strings: string[]): string
            endsWith(search: string, length?: number): boolean
            includes(search: string, position?: number): boolean
            indexOf(search: string, position?: number): number
            lastIndexOf(search: string, position?: number): number
            localeCompare(that: string): number
            match(regexp: RegExp): string[]
            matchAll(regexp: RegExp): Iterator
            normalize(form?: string): string
            padEnd(length: number, fill?: string): string
            padStart(length: number, fill?: string): string
            repeat(count: number): string
            replace(pattern: string | RegExp, replacement: string): string
            replaceAll(pattern: string | RegExp, replacement: string): string
            search(regexp: RegExp): number
            slice(start?: number, end?: number): string
            split(separator: string | RegExp, limit?: number): string[]
            startsWith(search: string, position?: number): boolean
            substring(start: number, end?: number): string
            toLowerCase(): string
            toUpperCase(): string
            toLocaleLowerCase(): string
            toLocaleUpperCase(): string
            toString(): string
            trim(): string
            trimEnd(): string
            trimStart(): string
            valueOf(): string
            """,
        ["Number"] = """
            toFixed(digits?: number): string
            toPrecision(precision?: number): string
            toExponential(digits?: number): string
            toLocaleString(locales?: string): string
            toString(radix?: number): string
            valueOf(): number
            """,
        ["Boolean"] = """
            toString(): string
            valueOf(): boolean
            """,
        ["Array"] = """
            length: number
            at(index: number): any
            concat(...items: any[]): any[]
            copyWithin(target: number, start: number, end?: number): any[]
            entries(): Iterator
            every(predicate: (value, index, array) => boolean): boolean
            fill(value: any, start?: number, end?: number): any[]
            filter(predicate: (value, index, array) => boolean): any[]
            find(predicate: (value, index, array) => boolean): any
            findIndex(predicate: (value, index, array) => boolean): number
            findLast(predicate: (value, index, array) => boolean): any
            findLastIndex(predicate: (value, index, array) => boolean): number
            flat(depth?: number): any[]
            flatMap(callback: (value, index, array) => any): any[]
            forEach(callback: (value, index, array) => void): void
            includes(value: any, fromIndex?: number): boolean
            indexOf(value: any, fromIndex?: number): number
            join(separator?: string): string
            keys(): Iterator
            lastIndexOf(value: any, fromIndex?: number): number
            map(callback: (value, index, array) => any): any[]
            pop(): any
            push(...items: any[]): number
            reduce(callback: (acc, value, index, array) => any, initial?: any): any
            reduceRight(callback: (acc, value, index, array) => any, initial?: any): any
            reverse(): any[]
            shift(): any
            slice(start?: number, end?: number): any[]
            some(predicate: (value, index, array) => boolean): boolean
            sort(compare?: (a, b) => number): any[]
            splice(start: number, deleteCount?: number, ...items: any[]): any[]
            toReversed(): any[]
            toSorted(compare?: (a, b) => number): any[]
            toSpliced(start: number, deleteCount?: number, ...items: any[]): any[]
            toString(): string
            unshift(...items: any[]): number
            values(): Iterator
            with(index: number, value: any): any[]
            """,
        ["Map"] = """
            size: number
            clear(): void
            delete(key: any): boolean
            entries(): Iterator
            forEach(callback: (value, key, map) => void): void
            get(key: any): any
            has(key: any): boolean
            keys(): Iterator
            set(key: any, value: any): Map
            values(): Iterator
            """,
        ["Set"] = """
            size: number
            add(value: any): Set
            clear(): void
            delete(value: any): boolean
            difference(other: Set): Set
            entries(): Iterator
            forEach(callback: (value, value2, set) => void): void
            has(value: any): boolean
            intersection(other: Set): Set
            isSubsetOf(other: Set): boolean
            isSupersetOf(other: Set): boolean
            keys(): Iterator
            symmetricDifference(other: Set): Set
            union(other: Set): Set
            values(): Iterator
            """,
        ["Promise"] = """
            then(onFulfilled?: (value) => any, onRejected?: (reason) => any): Promise
            catch(onRejected: (reason) => any): Promise
            finally(onFinally: () => void): Promise
            """,
        ["Date"] = """
            getDate(): number
            getDay(): number
            getFullYear(): number
            getHours(): number
            getMilliseconds(): number
            getMinutes(): number
            getMonth(): number
            getSeconds(): number
            getTime(): number
            getTimezoneOffset(): number
            setDate(date: number): number
            setFullYear(year: number): number
            setHours(hours: number): number
            setMinutes(minutes: number): number
            setMonth(month: number): number
            setSeconds(seconds: number): number
            setTime(time: number): number
            toDateString(): string
            toISOString(): string
            toJSON(): string
            toLocaleDateString(locales?: string, options?: object): string
            toLocaleString(locales?: string, options?: object): string
            toLocaleTimeString(locales?: string, options?: object): string
            toString(): string
            toTimeString(): string
            valueOf(): number
            """,
        ["RegExp"] = """
            exec(text: string): string[]
            test(text: string): boolean
            flags: string
            global: boolean
            lastIndex: number
            source: string
            """,
        ["Error"] = """
            message: string
            name: string
            stack: string
            cause: any
            """,
        ["Function"] = """
            apply(thisArg: any, args?: any[]): any
            bind(thisArg: any, ...args: any[]): Function
            call(thisArg: any, ...args: any[]): any
            length: number
            name: string
            """,
        ["Iterator"] = """
            next(): object
            """,
        ["Element"] = """
            addEventListener(type: string, listener: (event) => void, options?: object): void
            append(...nodes: any[]): void
            appendChild(node: Element): Element
            after(...nodes: any[]): void
            before(...nodes: any[]): void
            blur(): void
            children: HTMLCollection
            classList: DOMTokenList
            className: string
            click(): void
            closest(selectors: string): Element
            dataset: object
            disabled: boolean
            firstElementChild: Element
            focus(): void
            getAttribute(name: string): string
            getBoundingClientRect(): object
            hasAttribute(name: string): boolean
            hidden: boolean
            id: string
            innerHTML: string
            innerText: string
            insertAdjacentHTML(position: string, html: string): void
            lastElementChild: Element
            matches(selectors: string): boolean
            nextElementSibling: Element
            parentElement: Element
            prepend(...nodes: any[]): void
            querySelector(selectors: string): Element
            querySelectorAll(selectors: string): NodeList
            remove(): void
            removeAttribute(name: string): void
            removeChild(child: Element): Element
            removeEventListener(type: string, listener: (event) => void): void
            replaceChildren(...nodes: any[]): void
            replaceWith(...nodes: any[]): void
            scrollIntoView(options?: object): void
            setAttribute(name: string, value: string): void
            style: CSSStyleDeclaration
            tagName: string
            textContent: string
            toggleAttribute(name: string, force?: boolean): boolean
            value: string
            checked: boolean
            """,
        ["NodeList"] = """
            length: number
            entries(): Iterator
            forEach(callback: (node, index, list) => void): void
            item(index: number): Element
            keys(): Iterator
            values(): Iterator
            """,
        ["HTMLCollection"] = """
            length: number
            item(index: number): Element
            namedItem(name: string): Element
            """,
        ["DOMTokenList"] = """
            length: number
            add(...tokens: string[]): void
            contains(token: string): boolean
            remove(...tokens: string[]): void
            replace(token: string, newToken: string): boolean
            toggle(token: string, force?: boolean): boolean
            value: string
            """,
        ["CSSStyleDeclaration"] = """
            background: string
            backgroundColor: string
            border: string
            color: string
            display: string
            fontSize: string
            height: string
            margin: string
            opacity: string
            padding: string
            transform: string
            width: string
            getPropertyValue(property: string): string
            setProperty(property: string, value: string): void
            """,
        ["Storage"] = """
            length: number
            clear(): void
            getItem(key: string): string
            key(index: number): string
            removeItem(key: string): void
            setItem(key: string, value: string): void
            """,
        ["Response"] = """
            ok: boolean
            status: number
            statusText: string
            headers: object
            url: string
            json(): Promise
            text(): Promise
            blob(): Promise
            arrayBuffer(): Promise
            """,
        ["console"] = """
            assert(condition: boolean, ...data: any[]): void
            clear(): void
            count(label?: string): void
            debug(...data: any[]): void
            dir(item: any): void
            error(...data: any[]): void
            group(...label: any[]): void
            groupEnd(): void
            info(...data: any[]): void
            log(...data: any[]): void
            ## Prints its arguments to the console, separated by spaces.
            table(data: any, columns?: string[]): void
            time(label?: string): void
            timeEnd(label?: string): void
            trace(...data: any[]): void
            warn(...data: any[]): void
            """,
        ["Math"] = """
            E: number
            LN10: number
            LN2: number
            LOG10E: number
            LOG2E: number
            PI: number
            SQRT2: number
            abs(x: number): number
            acos(x: number): number
            asin(x: number): number
            atan(x: number): number
            atan2(y: number, x: number): number
            cbrt(x: number): number
            ceil(x: number): number
            cos(x: number): number
            exp(x: number): number
            floor(x: number): number
            hypot(...values: number[]): number
            log(x: number): number
            log10(x: number): number
            log2(x: number): number
            max(...values: number[]): number
            min(...values: number[]): number
            pow(x: number, y: number): number
            random(): number
            ## A pseudo-random number from 0 (inclusive) to 1 (exclusive).
            round(x: number): number
            sign(x: number): number
            sin(x: number): number
            sqrt(x: number): number
            tan(x: number): number
            trunc(x: number): number
            """,
        ["JSON"] = """
            parse(text: string, reviver?: (key, value) => any): any
            ## Turns JSON text into a value.
            stringify(value: any, replacer?: any, space?: string | number): string
            ## Turns a value into JSON text.
            """,
        ["document"] = """
            body: Element
            cookie: string
            documentElement: Element
            head: Element
            title: string
            addEventListener(type: string, listener: (event) => void): void
            createElement(tagName: string): Element
            createTextNode(text: string): Element
            getElementById(id: string): Element
            getElementsByClassName(names: string): HTMLCollection
            getElementsByTagName(name: string): HTMLCollection
            querySelector(selectors: string): Element
            ## The first element that matches a CSS selector, or null.
            querySelectorAll(selectors: string): NodeList
            removeEventListener(type: string, listener: (event) => void): void
            """,
        ["window"] = """
            document: document
            localStorage: Storage
            sessionStorage: Storage
            innerHeight: number
            innerWidth: number
            location: object
            addEventListener(type: string, listener: (event) => void): void
            alert(message?: any): void
            clearInterval(id: number): void
            clearTimeout(id: number): void
            confirm(message?: string): boolean
            fetch(input: string, init?: object): Promise
            prompt(message?: string, defaultValue?: string): string
            requestAnimationFrame(callback: (time) => void): number
            scrollTo(x: number, y: number): void
            setInterval(handler: () => void, ms?: number): number
            setTimeout(handler: () => void, ms?: number): number
            """,
        ["process"] = """
            argv: string[]
            env: object
            platform: string
            cwd(): string
            exit(code?: number): void
            nextTick(callback: () => void): void
            stdout: object
            """,
        ["Object.static"] = """
            assign(target: object, ...sources: object[]): object
            create(proto: object): object
            defineProperty(obj: object, key: string, descriptor: object): object
            entries(obj: object): any[]
            ## [key, value] pairs of an object's own enumerable properties.
            freeze(obj: object): object
            fromEntries(entries: any[]): object
            getPrototypeOf(obj: object): object
            groupBy(items: any[], keyOf: (item) => string): object
            hasOwn(obj: object, key: string): boolean
            isFrozen(obj: object): boolean
            keys(obj: object): string[]
            ## The names of an object's own enumerable properties.
            values(obj: object): any[]
            """,
        ["Array.static"] = """
            from(items: any, mapFn?: (value, index) => any): any[]
            isArray(value: any): boolean
            of(...items: any[]): any[]
            """,
        ["Number.static"] = """
            EPSILON: number
            MAX_SAFE_INTEGER: number
            MIN_SAFE_INTEGER: number
            MAX_VALUE: number
            isFinite(value: any): boolean
            isInteger(value: any): boolean
            isNaN(value: any): boolean
            isSafeInteger(value: any): boolean
            parseFloat(text: string): number
            parseInt(text: string, radix?: number): number
            """,
        ["String.static"] = """
            fromCharCode(...codes: number[]): string
            fromCodePoint(...codePoints: number[]): string
            raw(template: object, ...substitutions: any[]): string
            """,
        ["Promise.static"] = """
            all(promises: any[]): Promise
            allSettled(promises: any[]): Promise
            any(promises: any[]): Promise
            race(promises: any[]): Promise
            reject(reason?: any): Promise
            resolve(value?: any): Promise
            withResolvers(): object
            """,
        ["Date.static"] = """
            now(): number
            parse(text: string): number
            UTC(year: number, month?: number, date?: number): number
            """,
        ["Map.static"] = """
            groupBy(items: any[], keyOf: (item) => any): Map
            """,
        ["Set.static"] = "",
        ["RegExp.static"] = "",
        ["Error.static"] = "",
        ["Boolean.static"] = "",
        ["global"] = """
            console: console
            ## The debugging console: console.log(...) prints.
            document: document
            ## The web page (in the browser).
            window: window
            globalThis: window
            Math: Math
            ## Mathematical constants and functions.
            JSON: JSON
            ## Converting values to and from JSON text.
            localStorage: Storage
            sessionStorage: Storage
            process: process
            ## The running Node.js process.
            Object: class Object.static
            Array: class Array.static
            String: class String.static
            Number: class Number.static
            Boolean: class Boolean.static
            Map: class Map.static
            Set: class Set.static
            WeakMap: class Map.static
            WeakSet: class Set.static
            Promise: class Promise.static
            Date: class Date.static
            RegExp: class RegExp.static
            Error: class Error.static
            TypeError: class Error.static
            RangeError: class Error.static
            SyntaxError: class Error.static
            Symbol(description?: string): symbol
            BigInt(value: any): bigint
            parseInt(text: string, radix?: number): number
            parseFloat(text: string): number
            isNaN(value: any): boolean
            isFinite(value: any): boolean
            setTimeout(handler: () => void, ms?: number): number
            setInterval(handler: () => void, ms?: number): number
            clearTimeout(id: number): void
            clearInterval(id: number): void
            queueMicrotask(callback: () => void): void
            structuredClone(value: any): any
            fetch(input: string, init?: object): Promise
            ## Starts an HTTP request; the Promise gives a Response.
            alert(message?: any): void
            confirm(message?: string): boolean
            prompt(message?: string, defaultValue?: string): string
            requestAnimationFrame(callback: (time) => void): number
            encodeURIComponent(text: string): string
            decodeURIComponent(text: string): string
            require(id: string): any
            ## Node.js: loads a module.
            module: object
            exports: object
            undefined: undefined
            NaN: number
            Infinity: number
            """,
    };

    static readonly Dictionary<string, Dictionary<string, Member>> Builtins = BuildBuiltins();

    static Dictionary<string, Dictionary<string, Member>> BuildBuiltins()
    {
        var all = new Dictionary<string, Dictionary<string, Member>>();
        foreach (var (type, src) in BuiltinSource)
        {
            var members = new Dictionary<string, Member>();
            Member? last = null;
            foreach (var raw in src.Split('\n'))
            {
                var line = raw.Trim();
                if (line.Length == 0) continue;
                if (line.StartsWith("##"))
                {
                    if (last is not null) members[last.Name] = last = last with { Doc = line[2..].Trim() };
                    continue;
                }
                var paren = line.IndexOf('(');
                var colon = line.IndexOf(':');
                Member m;
                if (paren > 0 && (colon < 0 || paren < colon))
                {
                    var name = line[..paren];
                    var ret = line[(line.LastIndexOf("):", StringComparison.Ordinal) + 2)..].Trim();
                    m = new(name, type == "global" ? "function" : "method", line, RetType(ret));
                }
                else
                {
                    var name = line[..colon].Trim();
                    var ty = line[(colon + 1)..].Trim();
                    if (ty.StartsWith("class "))
                        m = new(name, "class", name, ty[6..].Trim());
                    else
                        m = new(name, type == "global" ? "variable" : "property", line, RetType(ty));
                }
                members[m.Name] = last = m;
            }
            all[type] = members;
        }
        return all;
    }

    /// <summary>A type as written in the table -> the built-in it names (or null).</summary>
    static string? RetType(string ty)
    {
        ty = ty.Split('|')[0].Trim();
        if (ty.EndsWith("[]")) return "Array";
        return ty switch
        {
            "string" => "String", "number" => "Number", "boolean" => "Boolean",
            "any" or "void" or "object" or "symbol" or "bigint" or "undefined" or "" => null,
            _ => Builtins_Has(ty) ? ty : null,
        };
    }

    static bool Builtins_Has(string ty) => BuiltinSource.ContainsKey(ty);

    static Member? BuiltinMember(string type, string name) =>
        Builtins.TryGetValue(type, out var ms) && ms.TryGetValue(name, out var m) ? m : null;

    /// <summary>What `new X()` gives for a built-in constructor (Map.static -> Map ...).</summary>
    static string? InstanceOf(string staticName) => staticName switch
    {
        "Object.static" => null,
        _ when staticName.EndsWith(".static") => staticName[..^7],
        _ => null,
    };

    static readonly string JsKeywords = "async await break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield";
    static readonly string TsKeywords = " abstract any as boolean declare enum implements interface keyof namespace never number private protected public readonly satisfies string type unknown";
}
