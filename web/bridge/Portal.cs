// The account portal: friends register an account (with free starting coins) and look
// up their cash shop coins, from a web page. HNMO.Web calls the game server's API
// (POST /api/accounts, cash shop grants) with an API key that stays on this computer,
// never in the browser.

using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;

internal sealed class PortalOptions
{
    public string ApiBaseUrl { get; set; } = "http://127.0.0.1:8095";

    public string ApiKeyFile { get; set; } = "../save/api-key.txt";

    public string StartingCoinType { get; set; } = "WCoinC";

    public int StartingCoins { get; set; } = 1000;

    public int RegistrationsPerHourPerAddress { get; set; } = 5;
}

internal sealed record RegisterRequest(string LoginName, string Password, string? EMail);

internal sealed class Portal(PortalOptions options, string contentRoot, HttpClient http, ILogger<Portal> logger)
{
    private static readonly TimeSpan RateWindow = TimeSpan.FromHours(1);
    private readonly ConcurrentDictionary<IPAddress, List<DateTime>> _registrations = new();

    private string KeyFile => Path.GetFullPath(Path.Combine(contentRoot, options.ApiKeyFile));

    private string? ApiKey => File.Exists(this.KeyFile) ? File.ReadAllText(this.KeyFile).Trim() : null;

    public static void Map(WebApplication app, Portal portal)
    {
        app.MapGet("/portal/status", () => Results.Json(new { ready = !string.IsNullOrEmpty(portal.ApiKey), startingCoins = portal.StartingCoinsText }));
        app.MapPost("/portal/register", portal.RegisterAsync);
        app.MapGet("/portal/coins/{account}", portal.CoinsAsync);
        app.MapPost("/portal/setup", portal.SetupAsync);
    }

    private string StartingCoinsText => options.StartingCoins > 0 ? $"{options.StartingCoins} {options.StartingCoinType}" : string.Empty;

    private HttpRequestMessage ApiRequest(HttpMethod method, string path, object? body = null)
    {
        var request = new HttpRequestMessage(method, new Uri(new Uri(options.ApiBaseUrl), path));
        request.Headers.Add("X-Api-Key", this.ApiKey);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return request;
    }

    private bool TryCountRegistration(IPAddress address)
    {
        var now = DateTime.UtcNow;
        var times = this._registrations.GetOrAdd(address, _ => []);
        lock (times)
        {
            times.RemoveAll(time => now - time > RateWindow);
            if (times.Count >= options.RegistrationsPerHourPerAddress)
            {
                return false;
            }

            times.Add(now);
            return true;
        }
    }

    private async Task<IResult> RegisterAsync(HttpContext context, RegisterRequest request)
    {
        if (string.IsNullOrEmpty(this.ApiKey))
        {
            return Results.Json(new { error = "Registration isn't set up yet. Ask the host to finish the setup (README.txt)." }, statusCode: 503);
        }

        var address = context.Connection.RemoteIpAddress ?? IPAddress.None;
        if (!this.TryCountRegistration(address))
        {
            return Results.Json(new { error = "Too many registrations from your address. Try again in an hour." }, statusCode: 429);
        }

        using var response = await http.SendAsync(this.ApiRequest(HttpMethod.Post, "api/accounts", new { loginName = request.LoginName, password = request.Password, eMail = request.EMail }), context.RequestAborted).ConfigureAwait(false);
        switch (response.StatusCode)
        {
            case HttpStatusCode.Created:
                break;
            case HttpStatusCode.Conflict:
                return Results.Json(new { error = "That account name is taken." }, statusCode: 409);
            case HttpStatusCode.BadRequest:
                return Results.Json(new { error = "The account name needs 3 to 10 characters and the password 3 to 20 (letters, digits and symbols, no spaces in the name)." }, statusCode: 400);
            default:
                logger.LogWarning("Registration failed: {Status} {Body}", response.StatusCode, await response.Content.ReadAsStringAsync(context.RequestAborted).ConfigureAwait(false));
                return Results.Json(new { error = "The game server didn't accept the registration. Ask the host to check the API key." }, statusCode: 502);
        }

        if (options.StartingCoins > 0)
        {
            var grant = new { coinType = options.StartingCoinType, amount = options.StartingCoins, reason = "Welcome coins", reference = $"welcome-{request.LoginName}" };
            using var granted = await http.SendAsync(this.ApiRequest(HttpMethod.Post, $"api/accounts/{Uri.EscapeDataString(request.LoginName)}/cash-shop/grants", grant), context.RequestAborted).ConfigureAwait(false);
            if (!granted.IsSuccessStatusCode)
            {
                logger.LogWarning("Welcome coins for {Account} failed: {Status}", request.LoginName, granted.StatusCode);
            }
        }

        logger.LogInformation("Registered account {Account} from {Address}.", request.LoginName, address);
        return Results.Json(new { created = true, coins = this.StartingCoinsText });
    }

    private async Task<IResult> CoinsAsync(HttpContext context, string account)
    {
        if (string.IsNullOrEmpty(this.ApiKey))
        {
            return Results.Json(new { error = "The portal isn't set up yet." }, statusCode: 503);
        }

        using var response = await http.SendAsync(this.ApiRequest(HttpMethod.Get, $"api/accounts/{Uri.EscapeDataString(account)}/cash-shop"), context.RequestAborted).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return Results.Json(new { error = "There's no account with that name." }, statusCode: 404);
        }

        if (!response.IsSuccessStatusCode)
        {
            return Results.Json(new { error = "The game server didn't answer. Is it running?" }, statusCode: 502);
        }

        return Results.Content(await response.Content.ReadAsStringAsync(context.RequestAborted).ConfigureAwait(false), "application/json");
    }

    // The host pastes the API key here once; only from this computer.
    private async Task<IResult> SetupAsync(HttpContext context)
    {
        if (context.Connection.RemoteIpAddress is not { } remote || !IPAddress.IsLoopback(remote))
        {
            return Results.Json(new { error = "The setup only works on the host computer (http://localhost:8080/account.html)." }, statusCode: 403);
        }

        var body = await context.Request.ReadFromJsonAsync<Dictionary<string, string>>(context.RequestAborted).ConfigureAwait(false);
        var key = body?.GetValueOrDefault("apiKey")?.Trim();
        if (string.IsNullOrEmpty(key))
        {
            return Results.Json(new { error = "Paste the API key." }, statusCode: 400);
        }

        Directory.CreateDirectory(Path.GetDirectoryName(this.KeyFile)!);
        await File.WriteAllTextAsync(this.KeyFile, key, context.RequestAborted).ConfigureAwait(false);
        using var check = await http.SendAsync(this.ApiRequest(HttpMethod.Get, "api/status"), context.RequestAborted).ConfigureAwait(false);
        return check.IsSuccessStatusCode
            ? Results.Json(new { saved = true })
            : Results.Json(new { error = $"The key was saved, but the game server refused it ({(int)check.StatusCode}). Create an Administrator key." }, statusCode: 400);
    }
}
