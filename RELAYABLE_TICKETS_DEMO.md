# Relayable Tickets API - Demo Guide

## Overview
The relayable tickets endpoint now supports multiple date formats, making it much easier to use for demos and testing.

## Endpoint
```
GET /ticket/relayable
```

## Supported Date Formats

### 1. Simple Date (Recommended for Demos)
```
start=2025-08-20&end=2025-08-20
```
- **Start date**: Automatically set to 00:00:00 (beginning of day)
- **End date**: Automatically set to 23:59:59 (end of day)
- **Perfect for**: Daily reports, quick testing

### 2. Date with Time
```
start=2025-08-20&end=2025-08-20 21:00
```
- **Start date**: 2025-08-20 00:00:00 (beginning of day)
- **End date**: 2025-08-20 21:00:00 (specific time)
- **Perfect for**: Partial day reports, specific time ranges

### 3. Date Range
```
start=2025-08-19&end=2025-08-21
```
- **Start date**: 2025-08-19 00:00:00
- **End date**: 2025-08-21 23:59:59
- **Perfect for**: Multi-day reports, weekly summaries

### 4. ISO String (Original Format)
```
start=2025-08-20T00%3A00%3A00%2B02%3A00&end=2025-08-20T21%3A00%3A00%2B02%3A00
```
- **Still supported** for backward compatibility
- **Note**: Requires URL encoding

## Demo Examples

### Basic Daily Report
```bash
curl "{{base_url}}/ticket/relayable?start=2025-08-20&end=2025-08-20&pdf=true"
```

### Partial Day Report
```bash
curl "{{base_url}}/ticket/relayable?start=2025-08-20&end=2025-08-20 21:00&pdf=true"
```

### Multi-Day Report
```bash
curl "{{base_url}}/ticket/relayable?start=2025-08-19&end=2025-08-21&pdf=true"
```

### Compact PDF Export
```bash
curl "{{base_url}}/ticket/relayable?start=2025-08-20&end=2025-08-20&pdf=true&compact=true"
```

### Excel Export
```bash
curl "{{base_url}}/ticket/relayable?start=2025-08-20&end=2025-08-20&export=true"
```

## Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start` | string | required | Start date/time (various formats supported) |
| `end` | string | required | End date/time (various formats supported) |
| `commit` | boolean | false | Whether to commit the relay operation |
| `pdf` | boolean | false | Export as PDF file |
| `export` | boolean | false | Export as Excel file |
| `compact` | boolean | false | Use compact PDF format (only with pdf=true) |

## Benefits for Demos

1. **Easy to Modify**: Change dates quickly without URL encoding
2. **Human Readable**: Clear, understandable date formats
3. **Flexible**: Support for various use cases
4. **Backward Compatible**: Existing ISO string format still works
5. **Smart Parsing**: Automatically handles start/end of day for simple dates

## Tips for Demo

- Use simple dates like `2025-08-20` for quick daily reports
- Show different time ranges by changing just the end time
- Demonstrate multi-day reports with date ranges
- Use the `compact` parameter to show different PDF formats
- Show both PDF and Excel export options
