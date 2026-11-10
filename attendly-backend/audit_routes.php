<?php
$content = file_get_contents($argv[1]);
// Extract each route: method, path, and whether requireRole or anonymous appears
preg_match_all('/\[\s*\'(GET|POST|PUT|PATCH|DELETE)\'\s*,\s*\'([^\']+)\'\s*,\s*(function|fn)/', $content, $matches, PREG_SET_ORDER);
foreach ($matches as $i => $m) {
    $method = $m[1];
    $path   = $m[2];
    $start  = $m[0];
    // Find the closing bracket of the route array by scanning forward
    $pos = strpos($content, $start);
    $depth = 0;
    $end = $pos;
    $len = strlen($content);
    for ($j = $pos; $j < $len; $j++) {
        if ($content[$j] === '[') $depth++;
        elseif ($content[$j] === ']') {
            $depth--;
            if ($depth === 0) { $end = $j + 1; break; }
        }
    }
    $body = substr($content, $pos, $end - $pos);
    $hasRequireRole = strpos($body, 'requireRole') !== false;
    $hasAnonymous  = strpos($body, 'anonymous: true') !== false;
    $hasRequireUser = strpos($body, 'requireUser') !== false;
    $auth = $hasRequireRole ? 'role' : ($hasRequireUser ? 'user' : 'NONE');
    printf("%-7s %-32s auth=%-8s anonymous=%s\n", $method, $path, $auth, $hasAnonymous ? 'Y' : 'N');
}