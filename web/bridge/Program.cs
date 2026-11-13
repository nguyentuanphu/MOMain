// Relays game connections between a browser and OpenMU.
//
// Browsers can only open WebSockets, while the game servers speak MU's own packet
// protocol over TCP. The browser opens /relay?host=..&port=..&encrypted=0|1, and
// this program connects to that server like the desktop client's ClientLibrary does:
// it encrypts what the browser sends (SimpleModulus + Xor32 for game servers) and
// decrypts what the server sends. Every WebSocket message holds one whole packet.
//
// Only hosts in "AllowedHosts" (appsettings.json) can be reached, so the relay can't
// be used to connect anywhere else.

using System.Buffers;
using System.Net;
using System.Net.WebSockets;
using Microsoft.Extensions.Logging.Abstractions;
using MUnique.OpenMU.Network;
using MUnique.OpenMU.Network.SimpleModulus;
using MUnique.OpenMU.Network.Xor;
using Pipelines.Sockets.Unofficial;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
var allowedHosts = app.Configuration.GetSection("Relay:AllowedHosts").Get<string[]>() ?? ["127.0.0.1", "localhost"];
var allowLoopback = app.Configuration.GetValue("Relay:AllowLoopback", true);
var connectTimeout = TimeSpan.FromSeconds(app.Configuration.GetValue("Relay:ConnectTimeoutSeconds", 10));
const int MaximumPacketSize = 0xFFFF;

app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });

app.MapGet("/health", () => "ok");

app.Map("/relay", async context =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var host = context.Request.Query["host"].ToString();
    var encrypted = context.Request.Query["encrypted"] == "1";
    if (!int.TryParse(context.Request.Query["port"], out var port) || port is <= 0 or > 65535)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var endPoint = await ResolveAllowedAsync(host, port).ConfigureAwait(false);
    if (endPoint is null)
    {
        app.Logger.LogWarning("Refused relay to {Host}:{Port}, it isn't an allowed host.", host, port);
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync().ConfigureAwait(false);
    await RelayAsync(socket, endPoint, encrypted, context.RequestAborted).ConfigureAwait(false);
});

app.Run();

async Task<IPEndPoint?> ResolveAllowedAsync(string host, int port)
{
    if (string.IsNullOrWhiteSpace(host))
    {
        return null;
    }

    var addresses = IPAddress.TryParse(host, out var literal) ? [literal] : await Dns.GetHostAddressesAsync(host).ConfigureAwait(false);
    var allowedByName = allowedHosts.Contains(host, StringComparer.OrdinalIgnoreCase);
    var address = addresses.FirstOrDefault(a => allowedByName || (allowLoopback && IPAddress.IsLoopback(a)) || allowedHosts.Contains(a.ToString()));
    return address is null ? null : new IPEndPoint(address, port);
}

async Task RelayAsync(WebSocket socket, IPEndPoint endPoint, bool encrypted, CancellationToken cancellationToken)
{
    SocketConnection pipe;
    try
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(connectTimeout);
        pipe = await SocketConnection.ConnectAsync(endPoint).WaitAsync(timeout.Token).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
        app.Logger.LogInformation("Couldn't connect to {EndPoint}: {Message}", endPoint, ex.Message);
        await CloseQuietlyAsync(socket, WebSocketCloseStatus.EndpointUnavailable, "connect failed").ConfigureAwait(false);
        return;
    }

    var encryptor = encrypted ? new PipelinedXor32Encryptor(new PipelinedSimpleModulusEncryptor(pipe.Output, PipelinedSimpleModulusEncryptor.DefaultClientKey).Writer) : null;
    var decryptor = encrypted ? new PipelinedSimpleModulusDecryptor(pipe.Input, PipelinedSimpleModulusDecryptor.DefaultClientKey) : null;
    var connection = new Connection(pipe, decryptor, encryptor, NullLogger<Connection>.Instance);
    var sendLock = new SemaphoreSlim(1, 1);

    connection.PacketReceived += packet => SendToBrowserAsync(packet.ToArray());
    connection.Disconnected += () => CloseQuietlyAsync(socket, WebSocketCloseStatus.NormalClosure, "server closed");

    async ValueTask SendToBrowserAsync(byte[] bytes)
    {
        await sendLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                await socket.SendAsync(bytes, WebSocketMessageType.Binary, true, cancellationToken).ConfigureAwait(false);
            }
        }
        finally
        {
            sendLock.Release();
        }
    }

    var receiving = connection.BeginReceiveAsync();
    try
    {
        await ForwardBrowserPacketsAsync(socket, connection, cancellationToken).ConfigureAwait(false);
    }
    catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or InvalidOperationException)
    {
        app.Logger.LogDebug("Relay to {EndPoint} ended: {Message}", endPoint, ex.Message);
    }
    finally
    {
        await connection.DisconnectAsync().ConfigureAwait(false);
        await receiving.ConfigureAwait(false);
        await CloseQuietlyAsync(socket, WebSocketCloseStatus.NormalClosure, "relay closed").ConfigureAwait(false);
    }
}

async Task ForwardBrowserPacketsAsync(WebSocket socket, Connection connection, CancellationToken cancellationToken)
{
    var buffer = new byte[MaximumPacketSize];
    while (socket.State == WebSocketState.Open && connection.Connected)
    {
        var length = 0;
        ValueWebSocketReceiveResult result;
        do
        {
            if (length >= buffer.Length)
            {
                throw new InvalidOperationException("Packet too large.");
            }

            result = await socket.ReceiveAsync(buffer.AsMemory(length), cancellationToken).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return;
            }

            length += result.Count;
        }
        while (!result.EndOfMessage);

        if (!IsWholePacket(buffer.AsSpan(0, length)))
        {
            throw new InvalidOperationException("The browser sent a malformed packet.");
        }

        using (await connection.OutputLock.LockAsync().ConfigureAwait(false))
        {
            buffer.AsSpan(0, length).CopyTo(connection.Output.GetSpan(length));
            connection.Output.Advance(length);
            await connection.Output.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
    }
}

static bool IsWholePacket(ReadOnlySpan<byte> packet)
{
    if (packet.Length < 3)
    {
        return false;
    }

    return packet[0] switch
    {
        0xC1 or 0xC3 => packet[1] == packet.Length,
        0xC2 or 0xC4 => packet.Length >= 4 && ((packet[1] << 8) | packet[2]) == packet.Length,
        _ => false,
    };
}

static async ValueTask CloseQuietlyAsync(WebSocket socket, WebSocketCloseStatus status, string reason)
{
    try
    {
        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            await socket.CloseAsync(status, reason, CancellationToken.None).ConfigureAwait(false);
        }
    }
    catch (WebSocketException)
    {
        // The browser is already gone.
    }
}
