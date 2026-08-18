# Design note: conference badge scanner

A small service used on the door of a conference to check tickets.

## Components

- **Badge app** — a phone app the door staff run. It reads a QR code from the
  attendee's badge and sends the code to the check-in API.
- **Check-in API** — an HTTP service on a laptop behind the registration desk.
  It looks the code up in the ticket database and replies `valid` or `invalid`.
- **Ticket database** — a SQLite file on the same laptop. One row per ticket:
  ticket code, attendee name, email address, and whether it has been used.
- **Admin page** — a web page on the same laptop where staff can mark a ticket
  used or unused, and export the attendee list as CSV.

## How it works

1. Door staff open the badge app and connect it to the laptop over the venue wifi.
2. The app posts the scanned code to `http://laptop.local:8080/checkin`.
3. The API sets `used = 1` for that ticket and returns the attendee's name so the
   door staff can print a badge.
4. At the end of the day a staff member opens the admin page and exports the CSV
   to email to the organisers.

## Notes

- The API has no authentication. It is only reachable on the venue wifi.
- The admin page has a shared password, written on a sticky note on the laptop.
- The ticket database is copied to a USB stick each evening as a backup.
- Nothing is logged except the web server's default access log.
