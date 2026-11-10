<?php
declare(strict_types=1);

namespace Attendly;

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

require_once __DIR__ . '/PHPMailer/Exception.php';
require_once __DIR__ . '/PHPMailer/PHPMailer.php';
require_once __DIR__ . '/PHPMailer/SMTP.php';

final class Mailer
{
    public static function send(string $to, string $subject, string $htmlBody): bool
    {
        $config = require __DIR__ . '/../config/config.php';
        
        $mail = new PHPMailer(true);

        try {
            // SMTP Configuration
            $mail->isSMTP();
            $mail->Host       = $config['smtp_host'] ?? 'smtp.gmail.com';
            $mail->SMTPAuth   = true;
            $mail->Username   = $config['smtp_user'] ?? '';
            $mail->Password   = $config['smtp_pass'] ?? '';
            $mail->SMTPSecure = PHPMailer::ENCRYPTION_SMTPS;
            $mail->Port       = $config['smtp_port'] ?? 465;

            // Sender and Recipient
            $mail->setFrom($config['smtp_user'] ?? '', 'ATTENDLY');
            $mail->addAddress($to);

            // Content
            $mail->isHTML(true);
            $mail->Subject = $subject;
            $mail->Body    = $htmlBody;
            $mail->AltBody = strip_tags($htmlBody);

            $mail->send();
            error_log("[mailer] SUCCESS: Email sent to {$to}");
            return true;
        } catch (Exception $e) {
            error_log("[PHPMailer Error] Message could not be sent. Mailer Error: {$mail->ErrorInfo}");
            return false;
        }
    }

    public static function sendOtpEmail(string $to, string $otp): bool
    {
        $safeOtp = htmlspecialchars($otp, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $html = '<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Verify your ATTENDLY account</title>
</head>
<body style="margin:0;padding:40px 16px;background:#f4f4f5;font-family:Arial,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:500px;background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#1a4d3a;color:#ffffff;padding:24px 40px;text-align:center;font-size:24px;font-weight:700;letter-spacing:2px;">
              ATTENDLY
            </td>
          </tr>
          <tr>
            <td style="padding:40px;text-align:center;">
              <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#374151;">
                Hello! Use the verification code below to complete your registration.
              </p>
              <div style="margin:0 auto 24px;padding:18px 12px;background:#e6f7ef;border-radius:8px;color:#0e9f6e;font-size:32px;font-weight:700;letter-spacing:5px;line-height:1.2;">
                ' . $safeOtp . '
              </div>
              <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280;">
                This code expires in 10 minutes.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>';

        return self::send($to, 'Your ATTENDLY verification code', $html);
    }
}