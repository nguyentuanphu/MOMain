// Starts the whole game from one program: a portable PostgreSQL that keeps the save
// game in the HNMO folder, then the game server (with its admin panel), then opens the
// browser. Stopping HNMO (closing its window or Ctrl+C) stops both again.
//
// Only active when "Launcher:Enabled" is true, which the HNMO folder sets; in
// development the server and database are started separately.

using System.Diagnostics;
using System.Net.Sockets;

internal sealed class LauncherOptions
{
    public bool Enabled { get; set; }

    public string PostgresPath { get; set; } = "../postgres/bin";

    public string SavePath { get; set; } = "../save";

    public int DatabasePort { get; set; } = 55432;

    public string DatabasePassword { get; set; } = "admin";

    public string ServerPath { get; set; } = "../server";

    public string ServerProgram { get; set; } = "MUnique.OpenMU.Startup";

    public string AdminUrl { get; set; } = "http://127.0.0.1:8095";

    public int ConnectServerPort { get; set; } = 44406;

    public string? OpenBrowserUrl { get; set; } = "http://localhost:8080/";
}

internal sealed class GameLauncher(LauncherOptions options, string contentRoot, ILogger<GameLauncher> logger) : IHostedService
{
    private static readonly TimeSpan DatabaseStartTimeout = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan ServerStartTimeout = TimeSpan.FromMinutes(10);

    private Process? _server;
    private bool _databaseStarted;

    private string Full(string path) => Path.GetFullPath(Path.Combine(contentRoot, path));

    private string DatabaseDirectory => Path.Combine(this.Full(options.SavePath), "database");

    private string LogDirectory => Path.Combine(this.Full(options.SavePath), "logs");

    private string PostgresTool(string name) => Path.Combine(this.Full(options.PostgresPath), OperatingSystem.IsWindows() ? name + ".exe" : name);

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (!options.Enabled)
        {
            return Task.CompletedTask;
        }

        // Start in the background, so the web part answers right away and shows the game while the server comes up.
        _ = Task.Run(() => this.LaunchAsync(cancellationToken), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (this._server is { HasExited: false })
        {
            logger.LogInformation("Stopping the game server...");
            this._server.Kill(entireProcessTree: true);
            await this._server.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        }

        if (this._databaseStarted)
        {
            logger.LogInformation("Stopping the database...");
            await RunAsync(this.PostgresTool("pg_ctl"), ["stop", "-D", this.DatabaseDirectory, "-m", "fast", "-w"], cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task LaunchAsync(CancellationToken cancellationToken)
    {
        try
        {
            Directory.CreateDirectory(this.LogDirectory);
            if (await IsPortOpenAsync(options.ConnectServerPort, cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException($"Another game server is already running (port {options.ConnectServerPort} is in use). Close it and start HNMO again.");
            }

            await this.StartDatabaseAsync(cancellationToken).ConfigureAwait(false);
            this.StartServer();
            logger.LogInformation("The game server is starting. The first start sets up the save game and takes a few minutes.");
            await WaitForPortAsync(options.ConnectServerPort, ServerStartTimeout, cancellationToken).ConfigureAwait(false);
            logger.LogInformation("HNMO is ready. Play: {Play}  Admin panel: {Admin} (this computer only)", options.OpenBrowserUrl, options.AdminUrl);
            OpenBrowser(options.OpenBrowserUrl);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "HNMO couldn't start. See the logs in {LogDirectory}.", this.LogDirectory);
        }
    }

    private async Task StartDatabaseAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(Path.Combine(this.DatabaseDirectory, "PG_VERSION")))
        {
            logger.LogInformation("Creating the save game database in {Directory}...", this.DatabaseDirectory);
            Directory.CreateDirectory(this.DatabaseDirectory);
            var passwordFile = Path.Combine(this.Full(options.SavePath), "db-password.tmp");
            await File.WriteAllTextAsync(passwordFile, options.DatabasePassword, cancellationToken).ConfigureAwait(false);
            try
            {
                await RunAsync(this.PostgresTool("initdb"), ["-D", this.DatabaseDirectory, "-U", "postgres", "--pwfile", passwordFile, "-A", "scram-sha-256", "-E", "UTF8", "--locale=C"], cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                File.Delete(passwordFile);
            }
        }

        logger.LogInformation("Starting the database on port {Port}...", options.DatabasePort);
        var logFile = Path.Combine(this.LogDirectory, "database.log");
        // Only reachable from this computer.
        var settings = $"-p {options.DatabasePort} -c listen_addresses=127.0.0.1";
        if (!OperatingSystem.IsWindows())
        {
            // Linux and macOS: keep the database's socket file in the save folder, not in a system folder.
            settings += $" -c unix_socket_directories='{this.DatabaseDirectory}'";
        }
        await RunAsync(this.PostgresTool("pg_ctl"), ["start", "-D", this.DatabaseDirectory, "-l", logFile, "-o", settings, "-w", "-t", ((int)DatabaseStartTimeout.TotalSeconds).ToString()], cancellationToken).ConfigureAwait(false);
        this._databaseStarted = true;
    }

    private void StartServer()
    {
        var serverDirectory = this.Full(options.ServerPath);
        var program = Path.Combine(serverDirectory, OperatingSystem.IsWindows() ? options.ServerProgram + ".exe" : options.ServerProgram);
        var start = new ProcessStartInfo(program, ["-autostart", "-resolveIP:loopback", "-deamon"])
        {
            WorkingDirectory = serverDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        start.Environment["ASPNETCORE_URLS"] = options.AdminUrl;
        start.Environment["DB_ADMIN_PW"] = options.DatabasePassword;

        var log = new StreamWriter(Path.Combine(this.LogDirectory, "server.log"), append: true) { AutoFlush = true };
        this._server = Process.Start(start) ?? throw new InvalidOperationException("The game server didn't start.");
        this._server.OutputDataReceived += (_, e) => { if (e.Data is not null) { lock (log) { log.WriteLine(e.Data); } } };
        this._server.ErrorDataReceived += (_, e) => { if (e.Data is not null) { lock (log) { log.WriteLine(e.Data); } } };
        this._server.BeginOutputReadLine();
        this._server.BeginErrorReadLine();
        this._server.EnableRaisingEvents = true;
        this._server.Exited += (_, _) => logger.LogWarning("The game server stopped. See {Log}.", Path.Combine(this.LogDirectory, "server.log"));
    }

    private static async Task RunAsync(string program, string[] arguments, CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo(program, arguments) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        using var process = Process.Start(start) ?? throw new InvalidOperationException($"{program} didn't start.");
        var output = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var error = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"{Path.GetFileName(program)} failed: {await error.ConfigureAwait(false)}{await output.ConfigureAwait(false)}");
        }
    }

    private static async Task<bool> IsPortOpenAsync(int port, CancellationToken cancellationToken)
    {
        try
        {
            using var client = new TcpClient();
            await client.ConnectAsync("127.0.0.1", port, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    private static async Task WaitForPortAsync(int port, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var client = new TcpClient();
                await client.ConnectAsync("127.0.0.1", port, cancellationToken).ConfigureAwait(false);
                return;
            }
            catch (SocketException)
            {
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken).ConfigureAwait(false);
            }
        }

        throw new TimeoutException($"The game server didn't open port {port} in time.");
    }

    private static void OpenBrowser(string? url)
    {
        if (string.IsNullOrEmpty(url))
        {
            return;
        }

        try
        {
            if (OperatingSystem.IsWindows())
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            else if (OperatingSystem.IsMacOS())
            {
                Process.Start("open", url);
            }
            else
            {
                Process.Start("xdg-open", url);
            }
        }
        catch (Exception)
        {
            // No browser to open (e.g. on a server): the address is in the log.
        }
    }
}
