<?php
/**
 * ATTENDLY — JSON Response Helpers
 *
 * One place decides the response envelope so every endpoint looks the
 * same to js/api.js.
 */

declare(strict_types=1);

namespace Attendly;

final class Response
{
    /**
     * Convert array to XML using SimpleXMLElement
     */
    private static function arrayToXml($data, &$xml): void
    {
        foreach ($data as $key => $value) {
            if (is_numeric($key)) {
                $key = 'item';
            }
            if (is_array($value)) {
                $subnode = $xml->addChild($key);
                self::arrayToXml($value, $subnode);
            } else {
                // SimpleXML escapes on output; pre-escaping would turn "&"
                // into "&amp;amp;" for every client that reads XML.
                $xml->addChild($key, (string) $value);
            }
        }
    }

    /**
     * Emit a success payload and end the request.
     *
     * @param mixed $data  payload (already JSON-safe)
     * @param int   $status HTTP status code
     */
    public static function ok(mixed $data = null, int $status = 200): void
    {
        http_response_code($status);
        $accept = $_SERVER['HTTP_ACCEPT'] ?? '';
        if (stripos($accept, 'application/xml') !== false) {
            header('Content-Type: application/xml; charset=utf-8');
            $xml = new \SimpleXMLElement('<?xml version="1.0" encoding="UTF-8"?><response></response>');
            $payload = ['data' => $data];
            self::arrayToXml($payload, $xml);
            echo $xml->asXML();
            exit;
        }
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['data' => $data], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    /**
     * Emit an error payload and end the request.
     *
     * @param string $code    machine-readable code for the client
     * @param string $message human-readable message (safe to display)
     * @param int    $status  HTTP status code
     */
    public static function fail(string $code, string $message, int $status = 400): void
    {
        http_response_code($status);
        $accept = $_SERVER['HTTP_ACCEPT'] ?? '';
        if (stripos($accept, 'application/xml') !== false) {
            header('Content-Type: application/xml; charset=utf-8');
            $xml = new \SimpleXMLElement('<?xml version="1.0" encoding="UTF-8"?><response></response>');
            $payload = ['error' => ['code' => $code, 'message' => $message]];
            self::arrayToXml($payload, $xml);
            echo $xml->asXML();
            exit;
        }
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(
            ['error' => ['code' => $code, 'message' => $message]],
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        );
        exit;
    }

    /**
     * Decode a JSON request body into an array.
     *
     * @return array<string,mixed>
     */
    public static function body(): array
    {
        $raw = file_get_contents('php://input');
        if ($raw === false || trim($raw) === '') {
            return [];
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            self::fail('invalid_json', 'Request body must be a JSON object.', 400);
        }
        return $decoded;
    }

    /**
     * Fetch one required string field from the body.
     */
    public static function requireString(array $body, string $key): string
    {
        $value = $body[$key] ?? null;
        if (!is_string($value) || trim($value) === '') {
            self::fail('invalid_field', "Field \"$key\" is required.", 422);
        }
        return trim($value);
    }

    /**
     * Read a required positive integer id from the route match.
     */
    public static function requireId(array $matches, string $key): int
    {
        $id = $matches[$key] ?? null;
        if (!is_numeric($id) || (int) $id <= 0) {
            self::fail('invalid_id', "Route id \"$key\" is invalid.", 400);
        }
        return (int) $id;
    }

    /**
     * Read a required positive integer from the request body.
     *
     * Needed wherever a numeric id arrives in JSON rather than in the
     * path: without this, "abc" would silently cast to 0 and reach the
     * query as a foreign key miss instead of a validation error.
     */
    public static function requireBodyId(array $body, string $key): int
    {
        $value = $body[$key] ?? null;
        if (is_string($value)) {
            $value = trim($value);
        }
        if (!is_int($value) && !(is_string($value) && ctype_digit($value))) {
            self::fail('invalid_field', "Field \"$key\" must be a positive whole number.", 422);
        }
        $id = (int) $value;
        if ($id <= 0) {
            self::fail('invalid_field', "Field \"$key\" must be a positive whole number.", 422);
        }
        return $id;
    }
}