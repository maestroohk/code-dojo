using System.Net;
using System.Net.Sockets;

namespace CodeDojo;

/// <summary>
/// Connects the way browsers and Node do (RFC 8305, "happy eyeballs"): try the host's addresses in
/// turn, alternating IPv6 and IPv4, starting the next one 250 ms after the previous, and keep
/// the first connection that succeeds.
///
/// .NET's default handler tries addresses one after another. On a network that hands out IPv6
/// addresses but cannot route them, each IPv6 attempt stalls for about 20 seconds before IPv4 is
/// tried. That made the npm registry look unreachable to the dojo's 8-second check while npm
/// (Node) reached it in under a second.
/// </summary>
public static class HappyEyeballs
{
    static readonly TimeSpan Stagger = TimeSpan.FromMilliseconds(250);

    /// <summary>A handler for outgoing HTTPS calls (package registries) that uses this connect logic.</summary>
    public static SocketsHttpHandler Handler() => new()
    {
        ConnectCallback = ConnectAsync,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        AutomaticDecompression = DecompressionMethods.All,
    };

    public static async ValueTask<Stream> ConnectAsync(SocketsHttpConnectionContext context, CancellationToken ct)
    {
        var (host, port) = (context.DnsEndPoint.Host, context.DnsEndPoint.Port);
        var addresses = IPAddress.TryParse(host, out var literal) ? [literal] : await Dns.GetHostAddressesAsync(host, ct);
        var order = Interleave(addresses);
        if (order.Count == 0) throw new SocketException((int)SocketError.HostNotFound);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var running = new List<Task<Socket>>();
        Exception? last = null;
        var next = 0;
        while (true)
        {
            if (next < order.Count) running.Add(Attempt(order[next++], port, cts.Token));
            if (running.Count == 0) throw last ?? new SocketException((int)SocketError.HostUnreachable);

            // Wait for an attempt to finish, or for the moment to start the next one.
            var stagger = next < order.Count ? Task.Delay(Stagger, cts.Token) : Task.Delay(Timeout.Infinite, cts.Token);
            var finished = await Task.WhenAny(running.Cast<Task>().Append(stagger));
            if (finished == stagger) continue;

            var attempt = (Task<Socket>)finished;
            running.Remove(attempt);
            if (attempt.IsCompletedSuccessfully)
            {
                cts.Cancel();
                foreach (var loser in running)
                    _ = loser.ContinueWith(t => { if (t.IsCompletedSuccessfully) t.Result.Dispose(); }, TaskScheduler.Default);
                return new NetworkStream(attempt.Result, ownsSocket: true);
            }
            last = attempt.Exception?.GetBaseException() ?? last;
            // A failed attempt: go round and start the next address straight away.
        }
    }

    static async Task<Socket> Attempt(IPAddress address, int port, CancellationToken ct)
    {
        var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(address, port, ct);
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    /// <summary>IPv6, IPv4, IPv6, IPv4 … starting with the family DNS listed first.</summary>
    static List<IPAddress> Interleave(IPAddress[] addresses)
    {
        var v6 = new Queue<IPAddress>(addresses.Where(a => a.AddressFamily == AddressFamily.InterNetworkV6));
        var v4 = new Queue<IPAddress>(addresses.Where(a => a.AddressFamily == AddressFamily.InterNetwork));
        var preferV6 = addresses.Length > 0 && addresses[0].AddressFamily == AddressFamily.InterNetworkV6;
        var (first, second) = preferV6 ? (v6, v4) : (v4, v6);
        var order = new List<IPAddress>(addresses.Length);
        while (first.Count > 0 || second.Count > 0)
        {
            if (first.Count > 0) order.Add(first.Dequeue());
            if (second.Count > 0) order.Add(second.Dequeue());
        }
        return order;
    }
}
