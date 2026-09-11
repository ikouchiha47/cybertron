#pragma once
#include <stddef.h>

// A timezone entry. `shortLabel` is drawn on the small OLED rows (kept to
// real-world 3-4 letter zone abbreviations — IST, EST, GMT, etc. — rather
// than city names, so it never needs to be truncated mid-word to fit),
// `menuLabel` is shown in the web UI dropdown, `posix` is the POSIX TZ
// string passed to configTzTime(), and `iana` is the standard timezone
// name (e.g. "Asia/Kolkata") matched against the browser's own
// Intl.DateTimeFormat() timezone for auto-detect.
//
// This list is not literally every IANA identifier (~450 of them) — most
// of those are historical aliases for cities that share an identical
// *current* offset and DST rule (e.g. Europe/Paris and Europe/Berlin both
// resolve to the same "CET-1CEST,M3.5.0,M10.5.0/3" today). configTzTime()
// only understands one present-day rule anyway (no historical rule
// changes, unlike the full IANA tzdata the ESP32 core doesn't ship), so a
// longer list of aliases wouldn't add any new *behavior* — this covers
// every UTC offset and DST rule actually in use today.
struct TzOption {
  const char* shortLabel;
  const char* menuLabel;
  const char* posix;
  const char* iana;
};

static const TzOption kTzOptions[] = {
  { "BIT",   "Baker Island (UTC-12)",         "AoE12",                           "Etc/GMT+12" },
  { "SST",   "Samoa (UTC-11)",                "SST11",                           "Pacific/Pago_Pago" },
  { "HST",   "Hawaii (UTC-10)",                "HST10",                          "Pacific/Honolulu" },
  { "AKT",   "Anchorage (AKST/AKDT)",          "AKST9AKDT,M3.2.0,M11.1.0",       "America/Anchorage" },
  { "PT",    "Los Angeles (PST/PDT)",          "PST8PDT,M3.2.0,M11.1.0",         "America/Los_Angeles" },
  { "PT",    "Tijuana (PST/PDT)",              "PST8PDT,M3.2.0,M11.1.0",         "America/Tijuana" },
  { "MST",   "Phoenix (MST, no DST)",          "MST7",                           "America/Phoenix" },
  { "MT",    "Denver (MST/MDT)",               "MST7MDT,M3.2.0,M11.1.0",         "America/Denver" },
  { "CST",   "Mexico City (CST, no DST)",      "CST6",                           "America/Mexico_City" },
  { "CT",    "Chicago (CST/CDT)",              "CST6CDT,M3.2.0,M11.1.0",         "America/Chicago" },
  { "COT",   "Bogota (COT, no DST)",           "COT5",                           "America/Bogota" },
  { "PET",   "Lima (PET, no DST)",             "PET5",                           "America/Lima" },
  { "ET",    "New York (EST/EDT)",             "EST5EDT,M3.2.0,M11.1.0",         "America/New_York" },
  { "ET",    "Toronto (EST/EDT)",              "EST5EDT,M3.2.0,M11.1.0",         "America/Toronto" },
  { "VET",   "Caracas (VET, no DST)",          "VET4",                           "America/Caracas" },
  { "AT",    "Halifax (AST/ADT)",              "AST4ADT,M3.2.0,M11.1.0",         "America/Halifax" },
  { "CLT",   "Santiago (Chile)",               "CLT4CLST,M9.1.6/24,M4.1.6/24",   "America/Santiago" },
  { "NT",    "Newfoundland (NST/NDT)",         "NST3:30NDT,M3.2.0,M11.1.0",      "America/St_Johns" },
  { "ART",   "Buenos Aires (ART, no DST)",     "ART3",                           "America/Argentina/Buenos_Aires" },
  { "BRT",   "Sao Paulo (BRT, no DST)",        "BRT3",                           "America/Sao_Paulo" },
  { "AZOT",  "Azores (AZOT/AZOST)",            "AZOT1AZOST,M3.5.0/0,M10.5.0/1",  "Atlantic/Azores" },
  { "CVT",   "Cape Verde (CVT, no DST)",       "CVT1",                           "Atlantic/Cape_Verde" },
  { "UTC",   "UTC",                            "UTC0",                           "UTC" },
  { "GMT",   "Reykjavik (GMT, no DST)",        "GMT0",                           "Atlantic/Reykjavik" },
  { "UK",    "London (GMT/BST)",               "GMT0BST,M3.5.0/1,M10.5.0",       "Europe/London" },
  { "WET",   "Casablanca (WET/WEST)",          "WET0WEST,M3.5.0/2,M10.5.0/3",    "Africa/Casablanca" },
  { "CET",   "Central Europe (CET/CEST)",      "CET-1CEST,M3.5.0,M10.5.0/3",     "Europe/Berlin" },
  { "WAT",   "Lagos (WAT, no DST)",             "WAT-1",                          "Africa/Lagos" },
  { "EET",   "Athens (EET/EEST)",              "EET-2EEST,M3.5.0/3,M10.5.0/4",   "Europe/Athens" },
  { "EET",   "Cairo (EET, no DST)",            "EET-2",                          "Africa/Cairo" },
  { "SAST",  "Johannesburg (SAST, no DST)",    "SAST-2",                         "Africa/Johannesburg" },
  { "IST",   "Jerusalem (IST/IDT)",            "IST-2IDT,M3.4.4/26,M10.5.0",     "Asia/Jerusalem" },
  { "MSK",   "Moscow (MSK, no DST)",           "MSK-3",                          "Europe/Moscow" },
  { "EAT",   "Nairobi (EAT, no DST)",          "EAT-3",                          "Africa/Nairobi" },
  { "AST",   "Riyadh (AST, no DST)",           "AST-3",                          "Asia/Riyadh" },
  { "TRT",   "Istanbul (TRT, no DST)",         "TRT-3",                          "Europe/Istanbul" },
  { "IRST",  "Tehran (IRST, no DST)",          "IRST-3:30",                      "Asia/Tehran" },
  { "GST",   "Dubai (GST, no DST)",            "GST-4",                          "Asia/Dubai" },
  { "AZT",   "Baku (AZT, no DST)",             "AZT-4",                          "Asia/Baku" },
  { "AFT",   "Kabul (AFT, no DST)",            "AFT-4:30",                       "Asia/Kabul" },
  { "PKT",   "Karachi (PKT, no DST)",          "PKT-5",                          "Asia/Karachi" },
  { "YEKT",  "Yekaterinburg (YEKT, no DST)",   "YEKT-5",                         "Asia/Yekaterinburg" },
  { "IST",   "India (IST)",                    "IST-5:30",                       "Asia/Kolkata" },
  { "IST",   "Sri Lanka (IST, no DST)",        "IST-5:30",                       "Asia/Colombo" },
  { "NPT",   "Kathmandu (NPT, no DST)",        "NPT-5:45",                       "Asia/Kathmandu" },
  { "BST",   "Dhaka (BST, no DST)",            "BST-6",                          "Asia/Dhaka" },
  { "ALMT",  "Almaty (ALMT, no DST)",          "ALMT-6",                         "Asia/Almaty" },
  { "MMT",   "Yangon (MMT, no DST)",           "MMT-6:30",                       "Asia/Yangon" },
  { "ICT",   "Bangkok (ICT, no DST)",          "ICT-7",                          "Asia/Bangkok" },
  { "WIB",   "Jakarta (WIB, no DST)",          "WIB-7",                          "Asia/Jakarta" },
  { "CST",   "China (CST, no DST)",            "CST-8",                          "Asia/Shanghai" },
  { "SGT",   "Singapore (SGT, no DST)",        "SGT-8",                          "Asia/Singapore" },
  { "AWST",  "Perth (AWST, no DST)",           "AWST-8",                         "Australia/Perth" },
  { "PHT",   "Manila (PHT, no DST)",           "PHT-8",                          "Asia/Manila" },
  { "JST",   "Japan (JST, no DST)",            "JST-9",                          "Asia/Tokyo" },
  { "KST",   "Seoul (KST, no DST)",            "KST-9",                          "Asia/Seoul" },
  { "ACST",  "Adelaide (ACST/ACDT)",           "ACST-9:30ACDT,M10.1.0,M4.1.0/3", "Australia/Adelaide" },
  { "ACST",  "Darwin (ACST, no DST)",          "ACST-9:30",                      "Australia/Darwin" },
  { "AEST",  "Sydney (AEST/AEDT)",             "AEST-10AEDT,M10.1.0,M4.1.0/3",   "Australia/Sydney" },
  { "AEST",  "Brisbane (AEST, no DST)",        "AEST-10",                        "Australia/Brisbane" },
  { "SBT",   "Solomon Islands (SBT, no DST)",  "SBT-11",                         "Pacific/Guadalcanal" },
  { "NCT",   "Noumea (NCT, no DST)",           "NCT-11",                         "Pacific/Noumea" },
  { "NZST",  "Auckland (NZST/NZDT)",           "NZST-12NZDT,M9.5.0,M4.1.0/3",    "Pacific/Auckland" },
  { "FJT",   "Fiji (FJT/FJST)",                "FJT-12FJST,M11.1.0,M1.2.1/3",    "Pacific/Fiji" },
  { "TOT",   "Tonga (TOT, no DST)",            "TOT-13",                         "Pacific/Tongatapu" },
  { "LINT",  "Kiritimati (LINT, no DST)",      "LINT-14",                        "Pacific/Kiritimati" },
};
static const size_t kTzOptionCount = sizeof(kTzOptions) / sizeof(kTzOptions[0]);
