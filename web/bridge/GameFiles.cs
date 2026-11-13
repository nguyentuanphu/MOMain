// Serves the game's data files to the browser, as web/server.mjs does in development.
//
// The data files keep their names and folders. Two things are adapted on the fly:
//  - names are matched case-insensitively, as on Windows, because models and maps
//    reference their files with whatever case the original authors used;
//  - .OZJ and .OZT are unwrapped to the JPEG and TGA they contain, and a request for
//    "x.jpg" / "x.tga" falls back to "x.OZJ" / "x.OZT", the names models refer to.

using System.Collections.Concurrent;

internal sealed class GameFiles(string root)
{
    private const int OzjPrefixBytes = 24;
    private const int OztPrefixBytes = 4;

    private static readonly Dictionary<string, string> FallbackExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        [".jpg"] = ".ozj",
        [".jpeg"] = ".ozj",
        [".tga"] = ".ozt",
    };

    private static readonly Dictionary<string, string> ContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".json"] = "application/json; charset=utf-8",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".png"] = "image/png",
    };

    private readonly string _root = Path.GetFullPath(root);
    private readonly ConcurrentDictionary<string, Dictionary<string, string>?> _directories = new();

    public string Root => this._root;

    public async Task ServeAsync(HttpContext context, string relativePath)
    {
        var file = this.Resolve(relativePath);
        if (file is null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        var bytes = await File.ReadAllBytesAsync(file, context.RequestAborted).ConfigureAwait(false);
        var (offset, contentType) = Unwrap(file, bytes);
        context.Response.ContentType = contentType;
        context.Response.Headers.CacheControl = "public, max-age=86400";
        await context.Response.Body.WriteAsync(bytes.AsMemory(offset), context.RequestAborted).ConfigureAwait(false);
    }

    private static (int Offset, string ContentType) Unwrap(string file, byte[] bytes)
    {
        var extension = Path.GetExtension(file);
        if (extension.Equals(".ozj", StringComparison.OrdinalIgnoreCase))
        {
            var wrapped = bytes.Length > OzjPrefixBytes + 1 && bytes[OzjPrefixBytes] == 0xFF && bytes[OzjPrefixBytes + 1] == 0xD8;
            return (wrapped ? OzjPrefixBytes : 0, "image/jpeg");
        }

        if (extension.Equals(".ozt", StringComparison.OrdinalIgnoreCase))
        {
            return (Math.Min(OztPrefixBytes, bytes.Length), "image/x-tga");
        }

        if (extension.Equals(".tga", StringComparison.OrdinalIgnoreCase))
        {
            return (0, "image/x-tga");
        }

        return (0, ContentTypes.GetValueOrDefault(extension, "application/octet-stream"));
    }

    private string? Resolve(string relativePath)
    {
        var direct = this.ResolveIgnoringCase(relativePath);
        if (direct is not null)
        {
            return direct;
        }

        var extension = Path.GetExtension(relativePath);
        return FallbackExtensions.TryGetValue(extension, out var fallback)
            ? this.ResolveIgnoringCase(relativePath[..^extension.Length] + fallback)
            : null;
    }

    // Walks the path one folder at a time, ignoring case; refuses anything that would leave the root.
    private string? ResolveIgnoringCase(string relativePath)
    {
        var current = this._root;
        foreach (var part in relativePath.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (part is "." or ".." || part.Contains('\\'))
            {
                return null;
            }

            var entries = this._directories.GetOrAdd(current, ListDirectory);
            if (entries is null || !entries.TryGetValue(part, out var realName))
            {
                return null;
            }

            current = Path.Combine(current, realName);
        }

        return File.Exists(current) ? current : null;
    }

    private static Dictionary<string, string>? ListDirectory(string directory)
    {
        if (!Directory.Exists(directory))
        {
            return null;
        }

        var entries = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
        {
            entries.TryAdd(Path.GetFileName(entry), Path.GetFileName(entry));
        }

        return entries;
    }
}
