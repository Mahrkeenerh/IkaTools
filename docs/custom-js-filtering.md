# Custom JS Filtering Guide

The filter panel includes a **Custom JS** section where you can write JavaScript expressions to filter islands on the world map (and cities on the island view). This is useful for complex queries that the built-in chip/rule filters can't express.

## Prerequisites

- **Map scan** — Run a basic world scan from the popup's Maps tab (provides coordinates, tradegood, wonder, city count)
- **Full scan** — Required for rich data: alliance tags, player names, army scores, player details
- **CT scan** — Required for `_ctAvailable` / `_ctChecked` fields

Without a full scan, the rich-data fields (`_allyTags`, `_players`, etc.) will be empty.

## How to Use

1. Open the **filter panel** on the world map (funnel icon on the minimap)
2. Expand the **Custom JS** section at the bottom
3. Make sure the toggle is **ON**
4. Type a JavaScript expression in the textarea
5. Click **Apply** or press **Ctrl+Enter**

The expression receives each island as `i` and must return a truthy value for islands you want to **keep visible**. Non-matching islands are dimmed. The result is ANDed with any active chip/rule filters.

You don't need to write `return` — just write an expression (e.g. `i.cities > 3`).

## Available Fields

### Basic (always available after a map scan)

| Field | Type | Description |
|---|---|---|
| `i.x` | number | X coordinate |
| `i.y` | number | Y coordinate |
| `i.name` | string | Island name |
| `i.cities` | number | Number of cities |
| `i.tradegood` | number | 1 = Wine, 2 = Marble, 3 = Crystal, 4 = Sulfur |
| `i.wonder` | number | Wonder type (1-8) |
| `i.owner` | string | `"own"`, `"ally"`, `""`, or player name |
| `i.piracy` | boolean | Piracy attack in range |
| `i.helios` | boolean | Has Helios tower |
| `i.military` | boolean | Military units present |
| `i.war` | boolean | In war zone |

### Rich data (requires Full Scan)

| Field | Type | Description |
|---|---|---|
| `i._allyTags` | Set\<string\> | Alliance tags present on the island |
| `i._ownerNamesText` | string | `\n`-joined lowercased player names |
| `i._maxArmy` | number | Highest army score across all cities |
| `i._players` | Array | Detailed per-city player objects (see below) |

### CT data (requires CT Scan)

| Field | Type | Description |
|---|---|---|
| `i._ctAvailable` | boolean | Cultural treaty can be established |
| `i._ctChecked` | boolean | CT availability was scanned |

### Spy log

| Field | Type | Description |
|---|---|---|
| `i._looted` | number | Timestamp (ms) of last looted spy report on this island/city, `0` if never |

### Player object (`i._players[n]`)

Each entry in the `_players` array has:

| Field | Type |
|---|---|
| `.name` | string |
| `.ally` | string (alliance name) |
| `.allyId` | number |
| `.id` | number |
| `.state` | string (`"active"`, `"inactive"`, `"vacation"`) |
| `.cities` | number (cities on this island) |
| `.maxLevel` | number (highest building level) |
| `.place` | number (palace score) |
| `.building` | number |
| `.research` | number |
| `.army` | number |
| `.trader` | number |

## Examples

### Alliance + cultural treaty

Show islands where a specific alliance has players AND a cultural treaty is available:

```js
i._allyTags.has("-DR-") && i._ctAvailable
```

### High-army enemies

Islands with army score above 50k, excluding your alliance:

```js
i._maxArmy > 50000 && !i._allyTags.has("OURS")
```

### Find a player by name

```js
i._ownerNamesText.includes("alice")
```

### Specific player in a specific alliance with army threshold

```js
i._players.some(p => p.ally === "BO-M" && p.army >= 30000)
```

### Sulfur islands with CT available

```js
i.tradegood === 4 && i._ctAvailable
```

### Inactive players with high research

```js
i._players.some(p => p.state === "inactive" && p.research > 20000)
```

### Islands with multiple alliances

```js
i._allyTags.size > 1
```

### Multi-condition: wine, high army, not allied

```js
i.tradegood === 1 && i._maxArmy > 40000 && !i._allyTags.has("OURS")
```

## Tips

- **Save presets** — Click **Save** to store a query for reuse. Presets persist across sessions.
- **Copy coords** — Click **Copy coords** to copy all matching island coordinates (`[x:y]` format) to clipboard.
- **Toggle without losing code** — Turn the Custom JS toggle OFF to disable filtering without clearing your expression.
- **AND with chips** — Custom JS results are combined with chip/rule filters. An island must match both to stay visible.
- **Errors are safe** — If your expression throws on a specific island, that island is treated as non-matching. Syntax errors are shown below the textarea.
- **Multi-statement code** — For complex logic, use `return` explicitly:
  ```js
  const dominated = i._players.filter(p => p.ally === "-DR-");
  return dominated.length >= 2 && dominated.every(p => p.army > 10000);
  ```
