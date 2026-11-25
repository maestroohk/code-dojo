using System.Globalization;
using Microsoft.Data.Sqlite;

namespace CodeDojo;

/// <summary>
/// The sample databases the Database studio makes on first visit: a bookshop, a small company's HR
/// data and a movies database. Generated from a fixed seed, so everyone gets the same rows.
/// </summary>
static class SampleData
{
    static void Exec(SqliteConnection c, string sql)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    static void Insert(SqliteConnection c, string table, IEnumerable<object?[]> rows)
    {
        using var cmd = c.CreateCommand();
        SqliteParameter[]? ps = null;
        foreach (var row in rows)
        {
            if (ps is null)
            {
                cmd.CommandText = $"INSERT INTO {table} VALUES ({string.Join(", ", row.Select((_, i) => "$p" + i))})";
                ps = row.Select((_, i) => cmd.Parameters.Add(new SqliteParameter("$p" + i, null))).ToArray();
            }
            for (var i = 0; i < row.Length; i++) ps[i].Value = row[i] ?? DBNull.Value;
            cmd.ExecuteNonQuery();
        }
    }

    static T Pick<T>(this Random r, IReadOnlyList<T> list) => list[r.Next(list.Count)];
    static string Day(DateTime d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    static readonly string[] First = ["Amara", "Ben", "Chloe", "Daniel", "Elif", "Farah", "George", "Hana", "Isaac", "Jade", "Kofi", "Lena", "Mateo", "Nadia", "Oscar", "Priya", "Quinn", "Rosa", "Samuel", "Tara", "Umar", "Vera", "Wei", "Ximena", "Yusuf", "Zoe", "Aisha", "Bruno", "Carmen", "Dmitri", "Esther", "Felix", "Grace", "Hiro", "Ingrid", "Jonas", "Keisha", "Luca", "Maya", "Nikolai"];
    static readonly string[] Last = ["Okafor", "Smith", "Nguyen", "Garcia", "Kowalski", "Haddad", "Brown", "Tanaka", "Mensah", "Rossi", "Jensen", "Patel", "Silva", "Kim", "Murphy", "Novak", "Ahmed", "Fischer", "Lopez", "Wright", "Kariuki", "Dubois", "Hughes", "Sato", "Andersen", "Moreau", "Chen", "Nakamura", "Osei", "Bianchi"];
    static readonly string[] Cities = ["London", "Manchester", "Leeds", "Bristol", "Edinburgh", "Glasgow", "Cardiff", "Belfast", "Liverpool", "Nottingham"];

    // ---------------------------------------------------------------- bookshop

    public static void Bookshop(SqliteConnection c, Random r)
    {
        Exec(c, """
            CREATE TABLE authors (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                country TEXT,
                born INTEGER
            );
            CREATE TABLE books (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                author_id INTEGER NOT NULL REFERENCES authors(id),
                genre TEXT NOT NULL,
                published INTEGER,
                pages INTEGER,
                price REAL NOT NULL,
                stock INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE customers (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                city TEXT,
                joined TEXT NOT NULL
            );
            CREATE TABLE orders (
                id INTEGER PRIMARY KEY,
                customer_id INTEGER NOT NULL REFERENCES customers(id),
                ordered_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('placed', 'shipped', 'delivered', 'cancelled'))
            );
            CREATE TABLE order_items (
                order_id INTEGER NOT NULL REFERENCES orders(id),
                book_id INTEGER NOT NULL REFERENCES books(id),
                quantity INTEGER NOT NULL,
                unit_price REAL NOT NULL,
                PRIMARY KEY (order_id, book_id)
            );
            CREATE TABLE reviews (
                id INTEGER PRIMARY KEY,
                book_id INTEGER NOT NULL REFERENCES books(id),
                customer_id INTEGER NOT NULL REFERENCES customers(id),
                stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
                body TEXT
            );
            CREATE INDEX idx_books_author ON books(author_id);
            CREATE INDEX idx_orders_customer ON orders(customer_id);
            """);
        // Classic, out-of-copyright authors and their real works.
        object?[][] authors =
        [
            [1, "Jane Austen", "England", 1775], [2, "Charles Dickens", "England", 1812], [3, "Mary Shelley", "England", 1797],
            [4, "Leo Tolstoy", "Russia", 1828], [5, "Fyodor Dostoevsky", "Russia", 1821], [6, "Mark Twain", "United States", 1835],
            [7, "Herman Melville", "United States", 1819], [8, "Charlotte Brontë", "England", 1816], [9, "Emily Brontë", "England", 1818],
            [10, "Jules Verne", "France", 1828], [11, "Victor Hugo", "France", 1802], [12, "Arthur Conan Doyle", "Scotland", 1859],
            [13, "H. G. Wells", "England", 1866], [14, "Oscar Wilde", "Ireland", 1854], [15, "Bram Stoker", "Ireland", 1847],
            [16, "Louisa May Alcott", "United States", 1832], [17, "Robert Louis Stevenson", "Scotland", 1850], [18, "Homer", null, null],
        ];
        Insert(c, "authors", authors);
        (string Title, int Author, string Genre, int Year, int Pages)[] books =
        [
            ("Pride and Prejudice", 1, "Romance", 1813, 432), ("Emma", 1, "Romance", 1815, 474), ("Sense and Sensibility", 1, "Romance", 1811, 409), ("Persuasion", 1, "Romance", 1817, 249),
            ("Great Expectations", 2, "Literary", 1861, 505), ("Oliver Twist", 2, "Literary", 1838, 608), ("A Tale of Two Cities", 2, "Historical", 1859, 489), ("David Copperfield", 2, "Literary", 1850, 882),
            ("Frankenstein", 3, "Horror", 1818, 280), ("War and Peace", 4, "Historical", 1869, 1225), ("Anna Karenina", 4, "Literary", 1878, 864),
            ("Crime and Punishment", 5, "Literary", 1866, 671), ("The Brothers Karamazov", 5, "Literary", 1880, 796), ("The Idiot", 5, "Literary", 1869, 656),
            ("Adventures of Huckleberry Finn", 6, "Adventure", 1884, 366), ("The Adventures of Tom Sawyer", 6, "Adventure", 1876, 274),
            ("Moby-Dick", 7, "Adventure", 1851, 635), ("Jane Eyre", 8, "Romance", 1847, 532), ("Wuthering Heights", 9, "Romance", 1847, 416),
            ("Twenty Thousand Leagues Under the Seas", 10, "Science fiction", 1870, 426), ("Around the World in Eighty Days", 10, "Adventure", 1872, 256), ("Journey to the Center of the Earth", 10, "Science fiction", 1864, 240),
            ("Les Misérables", 11, "Historical", 1862, 1463), ("The Hunchback of Notre-Dame", 11, "Historical", 1831, 510),
            ("A Study in Scarlet", 12, "Mystery", 1887, 188), ("The Sign of the Four", 12, "Mystery", 1890, 166), ("The Hound of the Baskervilles", 12, "Mystery", 1902, 256),
            ("The Time Machine", 13, "Science fiction", 1895, 118), ("The War of the Worlds", 13, "Science fiction", 1898, 192), ("The Invisible Man", 13, "Science fiction", 1897, 160),
            ("The Picture of Dorian Gray", 14, "Literary", 1890, 254), ("Dracula", 15, "Horror", 1897, 418), ("Little Women", 16, "Literary", 1868, 759),
            ("Treasure Island", 17, "Adventure", 1883, 292), ("Strange Case of Dr Jekyll and Mr Hyde", 17, "Horror", 1886, 141), ("Kidnapped", 17, "Adventure", 1886, 288),
            ("The Odyssey", 18, "Poetry", -700, 541), ("The Iliad", 18, "Poetry", -750, 683),
        ];
        var prices = new List<double>();
        Insert(c, "books", books.Select((b, i) =>
        {
            var price = Math.Round(5.99 + r.Next(0, 15) + (b.Pages > 700 ? 4 : 0), 0) - 0.01;
            prices.Add(price);
            return new object?[] { i + 1, b.Title, b.Author, b.Genre, b.Year, b.Pages, price, r.Next(10) < 2 ? 0 : r.Next(1, 40) };
        }));
        var customers = Enumerable.Range(1, 60).Select(i =>
        {
            var (f, l) = (r.Pick(First), r.Pick(Last));
            return new object?[] { i, $"{f} {l}", r.Next(12) == 0 ? null : $"{f.ToLowerInvariant()}.{l.ToLowerInvariant()}{i}@example.com", r.Next(10) == 0 ? null : r.Pick(Cities), Day(new DateTime(2022, 1, 1).AddDays(r.Next(0, 900))) };
        }).ToList();
        Insert(c, "customers", customers);
        var orders = new List<object?[]>();
        var items = new List<object?[]>();
        for (var o = 1; o <= 240; o++)
        {
            var when = new DateTime(2024, 1, 1).AddDays(r.Next(0, 680)).AddMinutes(r.Next(8 * 60, 22 * 60));
            var status = when > new DateTime(2025, 10, 20) ? r.Pick(["placed", "shipped"]) : r.Next(14) == 0 ? "cancelled" : "delivered";
            orders.Add([o, 1 + (int)Math.Floor(Math.Pow(r.NextDouble(), 1.6) * 60), when.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture), status]);
            foreach (var book in Enumerable.Range(0, r.Next(1, 4)).Select(_ => r.Next(books.Length)).Distinct())
                items.Add([o, book + 1, r.Next(6) == 0 ? 2 : 1, prices[book]]);
        }
        Insert(c, "orders", orders);
        Insert(c, "order_items", items);
        string[] praise = ["Could not put it down.", "A slow start, then wonderful.", "Beautifully written.", "Not for me.", "Read it twice.", "The ending stayed with me for days.", "Too long, but worth it.", null!];
        Insert(c, "reviews", Enumerable.Range(1, 120).Select(i => new object?[] { i, r.Next(1, books.Length + 1), r.Next(1, 61), Math.Clamp(5 - (int)Math.Floor(Math.Pow(r.NextDouble(), 2) * 5), 1, 5), r.Pick(praise) }));
    }

    // ---------------------------------------------------------------- company

    public static void Company(SqliteConnection c, Random r)
    {
        Exec(c, """
            CREATE TABLE departments (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                location TEXT NOT NULL,
                budget INTEGER NOT NULL
            );
            CREATE TABLE jobs (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                min_salary INTEGER NOT NULL,
                max_salary INTEGER NOT NULL
            );
            CREATE TABLE employees (
                id INTEGER PRIMARY KEY,
                first_name TEXT NOT NULL,
                last_name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                hired TEXT NOT NULL,
                department_id INTEGER REFERENCES departments(id),
                job_id INTEGER NOT NULL REFERENCES jobs(id),
                manager_id INTEGER REFERENCES employees(id),
                salary INTEGER NOT NULL,
                left_on TEXT
            );
            CREATE TABLE salary_history (
                employee_id INTEGER NOT NULL REFERENCES employees(id),
                changed_on TEXT NOT NULL,
                salary INTEGER NOT NULL,
                PRIMARY KEY (employee_id, changed_on)
            );
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                department_id INTEGER NOT NULL REFERENCES departments(id),
                starts TEXT NOT NULL,
                ends TEXT
            );
            CREATE TABLE assignments (
                employee_id INTEGER NOT NULL REFERENCES employees(id),
                project_id INTEGER NOT NULL REFERENCES projects(id),
                role TEXT NOT NULL,
                hours_per_week INTEGER NOT NULL,
                PRIMARY KEY (employee_id, project_id)
            );
            CREATE INDEX idx_employees_department ON employees(department_id);
            CREATE INDEX idx_employees_manager ON employees(manager_id);
            """);
        Insert(c, "departments", new object?[][]
        {
            [1, "Executive", "London", 900000], [2, "Engineering", "London", 2400000], [3, "Sales", "Manchester", 1100000],
            [4, "Marketing", "Manchester", 650000], [5, "Finance", "Edinburgh", 500000], [6, "People", "Edinburgh", 380000], [7, "Support", "Cardiff", 540000],
        });
        (string Title, int Min, int Max)[] jobs =
        [
            ("Chief Executive", 180000, 260000), ("Head of Department", 95000, 150000), ("Senior Engineer", 70000, 98000), ("Engineer", 45000, 72000),
            ("Account Executive", 38000, 65000), ("Marketing Specialist", 36000, 58000), ("Accountant", 42000, 68000), ("HR Partner", 38000, 60000),
            ("Support Agent", 26000, 36000), ("Intern", 21000, 25000),
        ];
        Insert(c, "jobs", jobs.Select((j, i) => new object?[] { i + 1, j.Title, j.Min, j.Max }));
        var rows = new List<object?[]>();
        var history = new List<object?[]>();
        var used = new HashSet<string>();
        int Salary(int job) => (int)Math.Round((jobs[job - 1].Min + r.NextDouble() * (jobs[job - 1].Max - jobs[job - 1].Min)) / 500.0) * 500;
        void Add(int dept, int job, int? manager)
        {
            var id = rows.Count + 1;
            string f, l;
            do { (f, l) = (r.Pick(First), r.Pick(Last)); } while (!used.Add(f + l));
            var hired = new DateTime(2014, 3, 1).AddDays(r.Next(0, 4000));
            var salary = Salary(job);
            var left = r.Next(12) == 0 && manager is not null ? Day(hired.AddDays(r.Next(200, 1500))) : null;
            rows.Add([id, f, l, $"{f.ToLowerInvariant()}.{l.ToLowerInvariant()}@dojo-corp.example", Day(hired), job == 1 ? 1 : (r.Next(30) == 0 ? null : dept), job, manager, salary, left]);
            var s = (int)(salary * 0.82 / 500) * 500;
            for (var d = hired; d < new DateTime(2025, 6, 1) && s < salary; d = d.AddDays(365 + r.Next(-40, 60)), s = Math.Min(salary, s + (int)(salary * 0.06 / 500) * 500))
                history.Add([id, Day(d), s]);
            history.Add([id, Day(new DateTime(2025, 6, 1).AddDays(id)), salary]);
        }
        Add(1, 1, null);                                         // the CEO
        var heads = new Dictionary<int, int>();
        for (var d = 2; d <= 7; d++) { Add(d, 2, 1); heads[d] = rows.Count; }
        var staff = new (int Dept, int Job, int Count)[] { (2, 3, 7), (2, 4, 12), (2, 10, 3), (3, 5, 10), (4, 6, 6), (5, 7, 5), (6, 8, 4), (7, 9, 9), (7, 10, 1) };
        foreach (var (dept, job, count) in staff)
            for (var i = 0; i < count; i++)
            {
                // Engineers and interns report to a senior engineer when there is one.
                var manager = heads[dept];
                if (dept == 2 && job is 4 or 10)
                {
                    var seniors = rows.Where(x => (int)x[6]! == 3).Select(x => (int)x[0]!).ToList();
                    if (seniors.Count > 0) manager = r.Pick(seniors);
                }
                Add(dept, job, manager);
            }
        Insert(c, "employees", rows);
        Insert(c, "salary_history", history.DistinctBy(h => $"{h[0]}|{h[1]}"));
        object?[][] projects =
        [
            [1, "Payments platform", 2, "2024-02-01", null], [2, "Mobile app 2.0", 2, "2024-09-15", "2025-07-31"], [3, "Northern expansion", 3, "2025-01-06", null],
            [4, "Brand refresh", 4, "2024-05-01", "2024-12-20"], [5, "Year-end close automation", 5, "2025-03-01", null], [6, "Help centre rebuild", 7, "2024-11-01", null],
            [7, "Hiring pipeline", 6, "2025-04-14", null],
        ];
        Insert(c, "projects", projects);
        var assignments = new List<object?[]>();
        foreach (var p in projects)
        {
            var dept = (int)p[2]!;
            var pool = rows.Where(x => x[5] is int d && d == dept && x[9] is null).Select(x => (int)x[0]!).OrderBy(_ => r.Next()).Take(r.Next(3, 7)).ToList();
            for (var i = 0; i < pool.Count; i++) assignments.Add([pool[i], p[0], i == 0 ? "lead" : r.Pick(["developer", "analyst", "reviewer", "contributor"]), r.Pick([8, 12, 16, 20, 24, 32])]);
            if (dept != 2 && r.Next(2) == 0) assignments.Add([rows.First(x => (int)x[6]! == 3)[0], p[0], "advisor", 4]);
        }
        Insert(c, "assignments", assignments.DistinctBy(a => $"{a[0]}|{a[1]}"));
    }

    // ---------------------------------------------------------------- movies

    public static void Movies(SqliteConnection c, Random r)
    {
        Exec(c, """
            CREATE TABLE people (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                born INTEGER
            );
            CREATE TABLE movies (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                year INTEGER NOT NULL,
                minutes INTEGER,
                director_id INTEGER REFERENCES people(id),
                country TEXT
            );
            CREATE TABLE genres (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE movie_genres (
                movie_id INTEGER NOT NULL REFERENCES movies(id),
                genre_id INTEGER NOT NULL REFERENCES genres(id),
                PRIMARY KEY (movie_id, genre_id)
            );
            CREATE TABLE cast_members (
                movie_id INTEGER NOT NULL REFERENCES movies(id),
                person_id INTEGER NOT NULL REFERENCES people(id),
                character TEXT,
                billing INTEGER NOT NULL,
                PRIMARY KEY (movie_id, person_id)
            );
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                joined TEXT NOT NULL
            );
            CREATE TABLE ratings (
                user_id INTEGER NOT NULL REFERENCES users(id),
                movie_id INTEGER NOT NULL REFERENCES movies(id),
                score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
                rated_on TEXT NOT NULL,
                PRIMARY KEY (user_id, movie_id)
            );
            CREATE INDEX idx_ratings_movie ON ratings(movie_id);
            """);
        string[] people =
        [
            "Francis Ford Coppola", "Marlon Brando", "Al Pacino", "Steven Spielberg", "Harrison Ford", "Christopher Nolan", "Leonardo DiCaprio",
            "Hayao Miyazaki", "Bong Joon-ho", "Song Kang-ho", "Ridley Scott", "Sigourney Weaver", "James Cameron", "Kate Winslet",
            "Quentin Tarantino", "Uma Thurman", "Samuel L. Jackson", "Frank Darabont", "Tim Robbins", "Morgan Freeman", "Jonathan Demme",
            "Jodie Foster", "Anthony Hopkins", "Peter Jackson", "Elijah Wood", "Ian McKellen", "Robert Zemeckis", "Tom Hanks", "Greta Gerwig",
            "Saoirse Ronan", "Denis Villeneuve", "Ryan Gosling", "Amy Adams", "Damien Chazelle", "Emma Stone", "Michael Caine", "Christian Bale", "Heath Ledger",
        ];
        int?[] born = [1939, 1924, 1940, 1946, 1942, 1970, 1974, 1941, 1969, 1967, 1937, 1949, 1954, 1975, 1963, 1970, 1948, 1959, 1958, 1937, 1944, 1962, 1937, 1961, 1981, 1939, 1951, 1956, 1983, 1994, 1967, 1980, 1974, 1985, 1988, 1933, 1974, 1979];
        Insert(c, "people", people.Select((p, i) => new object?[] { i + 1, p, born[i] }));
        int P(string name) => Array.IndexOf(people, name) + 1;
        (string Title, int Year, int Minutes, string Director, string Country, string[] Genres, (string Actor, string Role)[] Cast)[] movies =
        [
            ("The Godfather", 1972, 175, "Francis Ford Coppola", "United States", ["Crime", "Drama"], [("Marlon Brando", "Vito Corleone"), ("Al Pacino", "Michael Corleone")]),
            ("The Godfather Part II", 1974, 202, "Francis Ford Coppola", "United States", ["Crime", "Drama"], [("Al Pacino", "Michael Corleone")]),
            ("Raiders of the Lost Ark", 1981, 115, "Steven Spielberg", "United States", ["Adventure", "Action"], [("Harrison Ford", "Indiana Jones")]),
            ("Jurassic Park", 1993, 127, "Steven Spielberg", "United States", ["Adventure", "Science fiction"], []),
            ("Saving Private Ryan", 1998, 169, "Steven Spielberg", "United States", ["War", "Drama"], [("Tom Hanks", "Captain Miller")]),
            ("Inception", 2010, 148, "Christopher Nolan", "United States", ["Science fiction", "Action"], [("Leonardo DiCaprio", "Cobb"), ("Michael Caine", "Miles")]),
            ("The Dark Knight", 2008, 152, "Christopher Nolan", "United States", ["Action", "Crime"], [("Christian Bale", "Bruce Wayne"), ("Heath Ledger", "The Joker"), ("Michael Caine", "Alfred"), ("Morgan Freeman", "Lucius Fox")]),
            ("Interstellar", 2014, 169, "Christopher Nolan", "United States", ["Science fiction", "Drama"], [("Michael Caine", "Professor Brand")]),
            ("Spirited Away", 2001, 125, "Hayao Miyazaki", "Japan", ["Animation", "Fantasy"], []),
            ("My Neighbor Totoro", 1988, 86, "Hayao Miyazaki", "Japan", ["Animation", "Family"], []),
            ("Princess Mononoke", 1997, 134, "Hayao Miyazaki", "Japan", ["Animation", "Fantasy"], []),
            ("Parasite", 2019, 132, "Bong Joon-ho", "South Korea", ["Thriller", "Drama"], [("Song Kang-ho", "Kim Ki-taek")]),
            ("Memories of Murder", 2003, 131, "Bong Joon-ho", "South Korea", ["Crime", "Thriller"], [("Song Kang-ho", "Park Doo-man")]),
            ("Alien", 1979, 117, "Ridley Scott", "United Kingdom", ["Horror", "Science fiction"], [("Sigourney Weaver", "Ripley")]),
            ("Blade Runner", 1982, 117, "Ridley Scott", "United States", ["Science fiction", "Thriller"], [("Harrison Ford", "Rick Deckard")]),
            ("Gladiator", 2000, 155, "Ridley Scott", "United States", ["Action", "Drama"], []),
            ("Aliens", 1986, 137, "James Cameron", "United States", ["Action", "Science fiction"], [("Sigourney Weaver", "Ripley")]),
            ("Titanic", 1997, 194, "James Cameron", "United States", ["Romance", "Drama"], [("Leonardo DiCaprio", "Jack Dawson"), ("Kate Winslet", "Rose DeWitt Bukater")]),
            ("Pulp Fiction", 1994, 154, "Quentin Tarantino", "United States", ["Crime"], [("Uma Thurman", "Mia Wallace"), ("Samuel L. Jackson", "Jules Winnfield")]),
            ("Kill Bill: Volume 1", 2003, 111, "Quentin Tarantino", "United States", ["Action", "Crime"], [("Uma Thurman", "The Bride")]),
            ("The Shawshank Redemption", 1994, 142, "Frank Darabont", "United States", ["Drama"], [("Tim Robbins", "Andy Dufresne"), ("Morgan Freeman", "Red")]),
            ("The Silence of the Lambs", 1991, 118, "Jonathan Demme", "United States", ["Thriller", "Crime"], [("Jodie Foster", "Clarice Starling"), ("Anthony Hopkins", "Hannibal Lecter")]),
            ("The Lord of the Rings: The Fellowship of the Ring", 2001, 178, "Peter Jackson", "New Zealand", ["Fantasy", "Adventure"], [("Elijah Wood", "Frodo Baggins"), ("Ian McKellen", "Gandalf")]),
            ("The Lord of the Rings: The Return of the King", 2003, 201, "Peter Jackson", "New Zealand", ["Fantasy", "Adventure"], [("Elijah Wood", "Frodo Baggins"), ("Ian McKellen", "Gandalf")]),
            ("Forrest Gump", 1994, 142, "Robert Zemeckis", "United States", ["Drama", "Romance"], [("Tom Hanks", "Forrest Gump")]),
            ("Back to the Future", 1985, 116, "Robert Zemeckis", "United States", ["Science fiction", "Comedy"], []),
            ("Lady Bird", 2017, 94, "Greta Gerwig", "United States", ["Comedy", "Drama"], [("Saoirse Ronan", "Christine McPherson")]),
            ("Little Women", 2019, 135, "Greta Gerwig", "United States", ["Drama", "Romance"], [("Saoirse Ronan", "Jo March")]),
            ("Arrival", 2016, 116, "Denis Villeneuve", "United States", ["Science fiction", "Drama"], [("Amy Adams", "Louise Banks")]),
            ("Blade Runner 2049", 2017, 164, "Denis Villeneuve", "United States", ["Science fiction", "Thriller"], [("Ryan Gosling", "K"), ("Harrison Ford", "Rick Deckard")]),
            ("La La Land", 2016, 128, "Damien Chazelle", "United States", ["Musical", "Romance"], [("Ryan Gosling", "Sebastian"), ("Emma Stone", "Mia")]),
            ("Whiplash", 2014, 106, "Damien Chazelle", "United States", ["Drama", "Music"], []),
        ];
        var genres = movies.SelectMany(m => m.Genres).Distinct().Order().ToList();
        Insert(c, "genres", genres.Select((g, i) => new object?[] { i + 1, g }));
        Insert(c, "movies", movies.Select((m, i) => new object?[] { i + 1, m.Title, m.Year, m.Minutes, P(m.Director), m.Country }));
        Insert(c, "movie_genres", movies.SelectMany((m, i) => m.Genres.Select(g => new object?[] { i + 1, genres.IndexOf(g) + 1 })));
        Insert(c, "cast_members", movies.SelectMany((m, i) => m.Cast.Select((a, b) => new object?[] { i + 1, P(a.Actor), a.Role, b + 1 })));
        string[] handles = ["popcorn", "reelfan", "nightowl", "critic", "matinee", "cinephile", "director_cut", "frame24", "silverscreen", "bingewatch"];
        var users = Enumerable.Range(1, 40).Select(i => new object?[] { i, $"{r.Pick(handles)}{r.Next(10, 99)}_{i}", Day(new DateTime(2021, 1, 1).AddDays(r.Next(0, 1500))) }).ToList();
        Insert(c, "users", users);
        // Each film has a "true" quality; ratings scatter around it.
        var quality = movies.Select(_ => 6.2 + r.NextDouble() * 3.3).ToArray();
        var ratings = new List<object?[]>();
        foreach (var u in users)
            foreach (var m in Enumerable.Range(0, movies.Length).OrderBy(_ => r.Next()).Take(r.Next(3, 18)))
                ratings.Add([u[0], m + 1, Math.Clamp((int)Math.Round(quality[m] + (r.NextDouble() - 0.5) * 4), 1, 10), Day(new DateTime(2023, 1, 1).AddDays(r.Next(0, 1000)))]);
        Insert(c, "ratings", ratings);
    }
}
