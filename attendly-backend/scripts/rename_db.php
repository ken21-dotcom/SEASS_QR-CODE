<?php
declare(strict_types=1);

/**
 * rename_db.php — copy an ATTENDLY database to a new name using PDO.
 *
 * MySQL/MariaDB do not support RENAME DATABASE. This script performs the
 * equivalent operation without touching the source database:
 *
 *   1. creates the target database with the source charset/collation;
 *   2. recreates every base table from SHOW CREATE TABLE (FK-safe order);
 *   3. copies every row, skipping generated columns;
 *   4. recreates views, rewriting the source database qualifier;
 *   5. verifies row counts and CHECKSUM TABLE values;
 *   6. points config/config.php at the target and re-grants the app user.
 *
 * The source database is never modified or dropped.
 *
 * Usage:
 *   php scripts/rename_db.php
 *   php scripts/rename_db.php --force
 *   php scripts/rename_db.php --admin-user=root --admin-password=secret
 *
 * Options:
 *   --old=NAME              source database (default: attendly_face_recognition)
 *   --new=NAME              target database (default: attendly_seass_db)
 *   --host=HOST             database host (default: config.php db.host)
 *   --port=PORT             database port (default: config.php db.port)
 *   --admin-user=USER       admin account used to create/copy (default: root)
 *   --admin-password=PASS   admin password (default: empty)
 *   --force                 drop the target first if it already exists
 *   --help                  show this help
 *
 * Environment fallbacks:
 *   ATTENDLY_DB_ADMIN_USER, ATTENDLY_DB_ADMIN_PASSWORD
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "rename_db.php must be run from the command line.\n");
    exit(1);
}

/**
 * Quote a MySQL identifier.
 */
function quoteIdent(string $identifier): string
{
    return '`' . str_replace('`', '``', $identifier) . '`';
}

function line(string $message = ''): void
{
    echo $message . PHP_EOL;
}

function fail(string $message): void
{
    fwrite(STDERR, 'ERROR: ' . $message . PHP_EOL);
    exit(1);
}

$options = getopt('', [
    'help',
    'force',
    'old:',
    'new:',
    'host:',
    'port:',
    'admin-user:',
    'admin-password:',
]);

if ($options === false) {
    fail('Could not parse command-line options.');
}

if (isset($options['help'])) {
    line('Usage: php scripts/rename_db.php [options]');
    line();
    line('  --old=NAME              source database (default: attendly_face_recognition)');
    line('  --new=NAME              target database (default: attendly_seass_db)');
    line('  --host=HOST             database host (default: config.php db.host)');
    line('  --port=PORT             database port (default: config.php db.port)');
    line('  --admin-user=USER       admin account used to create/copy (default: root)');
    line('  --admin-password=PASS   admin password (default: empty)');
    line('  --force                 drop the target first if it already exists');
    line('  --help                  show this help');
    exit(0);
}

$configPath = dirname(__DIR__) . '/config/config.php';
$config = [];
if (is_file($configPath)) {
    $loadedConfig = require $configPath;
    if (is_array($loadedConfig)) {
        $config = $loadedConfig;
    }
}

$oldDb = $options['old'] ?? 'attendly_face_recognition';
$newDb = $options['new'] ?? 'attendly_seass_db';
$host = $options['host'] ?? ($config['db']['host'] ?? '127.0.0.1');
$port = (int) ($options['port'] ?? ($config['db']['port'] ?? 3306));
$adminUser = $options['admin-user'] ?? (getenv('ATTENDLY_DB_ADMIN_USER') ?: 'root');
$adminPassword = $options['admin-password'] ?? (getenv('ATTENDLY_DB_ADMIN_PASSWORD') ?: '');
$force = isset($options['force']);

foreach (['source' => $oldDb, 'target' => $newDb] as $label => $name) {
    if (!is_string($name) || !preg_match('/^[A-Za-z0-9_]+$/', $name)) {
        fail('Invalid ' . $label . ' database name: ' . var_export($name, true));
    }
}

if ($oldDb === $newDb) {
    fail('Source and target database names must differ.');
}

try {
    $pdo = new PDO(
        'mysql:host=' . $host . ';port=' . $port . ';charset=utf8mb4',
        $adminUser,
        $adminPassword,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
} catch (PDOException $e) {
    fail(
        'Could not connect to MySQL as ' . $adminUser . ': ' . $e->getMessage() . PHP_EOL
        . 'Pass --admin-user and --admin-password (or set ATTENDLY_DB_ADMIN_USER / '
        . 'ATTENDLY_DB_ADMIN_PASSWORD).'
    );
}

$checkSource = $pdo->prepare(
    'SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
     FROM information_schema.SCHEMATA
     WHERE SCHEMA_NAME = ?'
);
$checkSource->execute([$oldDb]);
$sourceSchema = $checkSource->fetch();

if (!$sourceSchema) {
    fail('Source database ' . quoteIdent($oldDb) . ' does not exist.');
}

$checkTarget = $pdo->prepare(
    'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?'
);
$checkTarget->execute([$newDb]);
$targetExists = $checkTarget->fetchColumn() !== false;

if ($targetExists && !$force) {
    fail(
        'Target database ' . quoteIdent($newDb) . ' already exists.' . PHP_EOL
        . 'Re-run with --force to drop and recreate it, or choose another --new name.'
    );
}

if ($targetExists) {
    line('Dropping existing target ' . quoteIdent($newDb) . ' (--force)...');
    $pdo->exec('DROP DATABASE ' . quoteIdent($newDb));
}

$charset = (string) $sourceSchema['DEFAULT_CHARACTER_SET_NAME'];
$collation = (string) $sourceSchema['DEFAULT_COLLATION_NAME'];

if (!preg_match('/^[A-Za-z0-9_]+$/', $charset) || !preg_match('/^[A-Za-z0-9_]+$/', $collation)) {
    fail('Unexpected charset/collation on source database.');
}

$pdo->exec(
    'CREATE DATABASE ' . quoteIdent($newDb)
    . ' CHARACTER SET ' . $charset
    . ' COLLATE ' . $collation
);
$pdo->exec('USE ' . quoteIdent($newDb));

line('Created ' . quoteIdent($newDb) . ' (' . $charset . ' / ' . $collation . ').');

$listObjects = $pdo->prepare(
    "SELECT TABLE_NAME, TABLE_TYPE
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME"
);
$listObjects->execute([$oldDb]);

$baseTables = [];
$views = [];

foreach ($listObjects->fetchAll() as $row) {
    if ($row['TABLE_TYPE'] === 'VIEW') {
        $views[] = $row['TABLE_NAME'];
    } elseif ($row['TABLE_TYPE'] === 'BASE TABLE') {
        $baseTables[] = $row['TABLE_NAME'];
    } else {
        fail('Unsupported object type ' . $row['TABLE_TYPE'] . ' for ' . $row['TABLE_NAME'] . '.');
    }
}

if (!$baseTables) {
    fail('Source database ' . quoteIdent($oldDb) . ' has no base tables.');
}

line('Found ' . count($baseTables) . ' table(s) and ' . count($views) . ' view(s).');

/*
 * Build a dependency map from foreign keys so referenced tables are created
 * before the tables that depend on them. Circular dependencies are handled
 * by creating the remaining tables with FOREIGN_KEY_CHECKS disabled.
 */
$listForeignKeys = $pdo->prepare(
    'SELECT TABLE_NAME, REFERENCED_TABLE_NAME
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ?
       AND REFERENCED_TABLE_SCHEMA = ?
       AND REFERENCED_TABLE_NAME IS NOT NULL
       AND TABLE_NAME <> REFERENCED_TABLE_NAME'
);
$listForeignKeys->execute([$oldDb, $oldDb]);

$dependencies = [];
foreach ($listForeignKeys->fetchAll() as $row) {
    $dependencies[$row['TABLE_NAME']][$row['REFERENCED_TABLE_NAME']] = true;
}

$orderedTables = [];
$pendingTables = $baseTables;

while ($pendingTables) {
    $progress = false;

    foreach ($pendingTables as $key => $table) {
        if (!isset($pendingTables[$key])) {
            continue;
        }

        $parents = array_keys($dependencies[$table] ?? []);
        if (array_diff($parents, $orderedTables)) {
            continue;
        }

        $orderedTables[] = $table;
        unset($pendingTables[$key]);
        $progress = true;
    }

    if (!$progress) {
        line('  Note: circular foreign keys detected; creating the remaining tables with FK checks off.');
        foreach ($pendingTables as $table) {
            $orderedTables[] = $table;
        }
        break;
    }
}

$pdo->exec('SET FOREIGN_KEY_CHECKS = 0');

line('Creating tables...');
foreach ($orderedTables as $table) {
    $create = $pdo->query(
        'SHOW CREATE TABLE ' . quoteIdent($oldDb) . '.' . quoteIdent($table)
    )->fetch();

    if (!isset($create['Create Table'])) {
        fail('Could not read the CREATE TABLE statement for ' . quoteIdent($table) . '.');
    }

    $pdo->exec($create['Create Table']);
    line('  table  ' . $table);
}

/*
 * Copy data column-by-column so generated columns (which cannot be inserted
 * into) are skipped. The primary key formats are never altered.
 */
$listColumns = $pdo->prepare(
    "SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = ?
       AND EXTRA NOT LIKE '%GENERATED%'
     ORDER BY ORDINAL_POSITION"
);

line('Copying rows...');
$rowCounts = [];
$totalRows = 0;

foreach ($baseTables as $table) {
    $listColumns->execute([$oldDb, $table]);
    $columns = $listColumns->fetchAll(PDO::FETCH_COLUMN);

    if (!$columns) {
        fail('No copyable columns found for ' . quoteIdent($table) . '.');
    }

    $columnList = implode(', ', array_map('quoteIdent', $columns));

    $pdo->exec(
        'INSERT INTO ' . quoteIdent($newDb) . '.' . quoteIdent($table)
        . ' (' . $columnList . ')'
        . ' SELECT ' . $columnList
        . ' FROM ' . quoteIdent($oldDb) . '.' . quoteIdent($table)
    );

    $count = (int) $pdo->query(
        'SELECT COUNT(*) FROM ' . quoteIdent($oldDb) . '.' . quoteIdent($table)
    )->fetchColumn();

    $rowCounts[$table] = $count;
    $totalRows += $count;
    line('  data   ' . $table . ' (' . $count . ' row' . ($count === 1 ? '' : 's') . ')');
}

/*
 * Recreate views after all tables and data exist. SHOW CREATE VIEW includes
 * DEFINER and fully-qualified source names; strip the definer and rewrite the
 * source database qualifier so the view reads from the new database.
 */
foreach ($views as $view) {
    $create = $pdo->query(
        'SHOW CREATE VIEW ' . quoteIdent($oldDb) . '.' . quoteIdent($view)
    )->fetch();

    if (!isset($create['Create View'])) {
        fail('Could not read the CREATE VIEW statement for ' . quoteIdent($view) . '.');
    }

    $createSql = preg_replace('/\sDEFINER=`[^`]+`@`[^`]+`/', '', $create['Create View'], 1);
    if ($createSql === null) {
        fail('Could not normalize the view definition for ' . quoteIdent($view) . '.');
    }

    $createSql = str_replace(
        quoteIdent($oldDb) . '.',
        quoteIdent($newDb) . '.',
        $createSql
    );

    $pdo->exec($createSql);
    line('  view   ' . $view);
}

$pdo->exec('SET FOREIGN_KEY_CHECKS = 1');

line('Verifying copy...');
$verificationErrors = [];

foreach ($baseTables as $table) {
    $oldCount = (int) $pdo->query(
        'SELECT COUNT(*) FROM ' . quoteIdent($oldDb) . '.' . quoteIdent($table)
    )->fetchColumn();
    $newCount = (int) $pdo->query(
        'SELECT COUNT(*) FROM ' . quoteIdent($newDb) . '.' . quoteIdent($table)
    )->fetchColumn();

    if ($oldCount !== $newCount) {
        $verificationErrors[] = $table . ': old=' . $oldCount . ', new=' . $newCount;
        continue;
    }

    $checksums = $pdo->query(
        'CHECKSUM TABLE '
        . quoteIdent($oldDb) . '.' . quoteIdent($table) . ', '
        . quoteIdent($newDb) . '.' . quoteIdent($table)
    )->fetchAll();

    if (
        count($checksums) === 2
        && $checksums[0]['Checksum'] !== null
        && $checksums[1]['Checksum'] !== null
        && (string) $checksums[0]['Checksum'] !== (string) $checksums[1]['Checksum']
    ) {
        $verificationErrors[] = $table . ': CHECKSUM TABLE differs';
    }
}

$countNewViews = $pdo->prepare(
    'SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?'
);
$countNewViews->execute([$newDb]);
$newViewCount = (int) $countNewViews->fetchColumn();

if ($newViewCount !== count($views)) {
    $verificationErrors[] = 'view count: old=' . count($views) . ', new=' . $newViewCount;
}

foreach ($views as $view) {
    try {
        $pdo->query(
            'SELECT * FROM ' . quoteIdent($newDb) . '.' . quoteIdent($view) . ' LIMIT 1'
        )->fetchAll();
    } catch (Throwable $e) {
        $verificationErrors[] = 'view ' . $view . ' is not queryable: ' . $e->getMessage();
    }
}

$staleViews = $pdo->prepare(
    'SELECT TABLE_NAME
     FROM information_schema.VIEWS
     WHERE TABLE_SCHEMA = ?
       AND VIEW_DEFINITION LIKE ?'
);
$staleViews->execute([$newDb, '%' . $oldDb . '%']);
$staleViewNames = $staleViews->fetchAll(PDO::FETCH_COLUMN);

if ($staleViewNames) {
    $verificationErrors[] = 'views still reference ' . $oldDb . ': ' . implode(', ', $staleViewNames);
}

if (in_array('schema_migrations', $baseTables, true)) {
    $migrationCount = (int) $pdo->query(
        'SELECT COUNT(*) FROM ' . quoteIdent($newDb) . '.schema_migrations'
    )->fetchColumn();
    $latestMigration = $pdo->query(
        'SELECT MAX(filename) FROM ' . quoteIdent($newDb) . '.schema_migrations'
    )->fetchColumn();

    line(
        '  schema_migrations: ' . $migrationCount
        . ' row(s), latest file ' . var_export($latestMigration, true)
    );
}

if ($verificationErrors) {
    fail(
        'Verification failed:' . PHP_EOL
        . '  - ' . implode(PHP_EOL . '  - ', $verificationErrors) . PHP_EOL
        . 'The source database was not modified. Do not drop it.'
    );
}

line('Verified ' . count($baseTables) . ' table(s), ' . $totalRows . ' row(s), and ' . count($views) . ' view(s).');

if (!is_file($configPath)) {
    fail('config.php not found at ' . $configPath . '.');
}

$configContents = file_get_contents($configPath);
if ($configContents === false) {
    fail('Could not read ' . $configPath . '.');
}

$updatedContents = preg_replace(
    "/(['\"]dbname['\"]\s*=>\s*['\"])[^'\"]+(['\"])/",
    '${1}' . $newDb . '${2}',
    $configContents,
    1
);

if ($updatedContents === null) {
    fail('Could not update config.php.');
}

if ($updatedContents === $configContents) {
    line('config.php already points to ' . quoteIdent($newDb) . '.');
} else {
    if (file_put_contents($configPath, $updatedContents) === false) {
        fail('Could not write ' . $configPath . '.');
    }
    line('config.php now points to ' . quoteIdent($newDb) . '.');
}

$reloadedConfig = require $configPath;
if (!is_array($reloadedConfig) || ($reloadedConfig['db']['dbname'] ?? null) !== $newDb) {
    fail('config.php does not contain the expected dbname after the update.');
}

/*
 * The app user only had privileges on the old database, so mirror those
 * privileges onto the new one. This needs an admin connection.
 */
$appUser = $config['db']['user'] ?? null;
$appPassword = $config['db']['password'] ?? '';

if (is_string($appUser) && $appUser !== '' && $appUser !== $adminUser) {
    line('Granting app user access to ' . quoteIdent($newDb) . '...');

    try {
        $appPdo = new PDO(
            'mysql:host=' . $host . ';port=' . $port . ';dbname=' . $oldDb . ';charset=utf8mb4',
            $appUser,
            $appPassword,
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]
        );

        $currentUser = (string) $appPdo->query('SELECT CURRENT_USER()')->fetchColumn();
        $atPosition = strrpos($currentUser, '@');

        if ($atPosition === false) {
            throw new RuntimeException('Unexpected CURRENT_USER() value: ' . $currentUser);
        }

        $grantUser = substr($currentUser, 0, $atPosition);
        $grantHost = substr($currentUser, $atPosition + 1);

        $pdo->exec(
            'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER ON '
            . quoteIdent($newDb) . '.* TO '
            . $pdo->quote($grantUser) . '@' . $pdo->quote($grantHost)
        );

        line('  granted ' . $grantUser . '@' . $grantHost . ' on ' . quoteIdent($newDb) . '.*.');
    } catch (Throwable $e) {
        line('  WARNING: automatic grant failed: ' . $e->getMessage());
        line('  Run this manually as an admin:');
        line(
            '    GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER ON '
            . quoteIdent($newDb) . ".* TO '<app-user>'@'<host>';"
        );
    }
}

line();
line('Rename complete.');
line('  source: ' . quoteIdent($oldDb) . ' (unchanged)');
line('  target: ' . quoteIdent($newDb));
line(
    '  copied: ' . count($baseTables) . ' table(s), '
    . $totalRows . ' row(s), ' . count($views) . ' view(s)'
);
line('  config: ' . $configPath);
line();
line('Pending migrations were copied as-is. Apply them with:');
line('  cd attendly-backend && php db/migrate.php');
line();
line('The old database was NOT dropped. After smoke-testing the app, drop it manually:');
line('  DROP DATABASE ' . quoteIdent($oldDb) . ';');
