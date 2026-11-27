using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace Shop;

/// <summary>A thin helper over SQLite. The database file is created and seeded when the lab starts.</summary>
public static class Db
{
    public static string ConnectionString { get; set; } = "Data Source=/work/data/shop.db";

    public static SqliteConnection Open()
    {
        var c = new SqliteConnection(ConnectionString);
        c.Open();
        return c;
    }

    /// <summary>Runs a query and returns every row as a dictionary (column name to value).</summary>
    public static List<Dictionary<string, object?>> Query(string sql, params (string Name, object? Value)[] args)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        using var r = cmd.ExecuteReader();
        var rows = new List<Dictionary<string, object?>>();
        while (r.Read())
        {
            var row = new Dictionary<string, object?>();
            for (var i = 0; i < r.FieldCount; i++) row[r.GetName(i)] = r.IsDBNull(i) ? null : r.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }

    public static int Exec(string sql, params (string Name, object? Value)[] args)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return cmd.ExecuteNonQuery();
    }

    public static string Sha256(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
}
