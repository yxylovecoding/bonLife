// Read-only bridge. No triggers, calendar writes, mail or external destinations.
// Set BON_CALENDAR_SECRET and BON_CALENDARS (JSON name -> calendar ID) in Script Properties.
function doPost(e) {
  var protocol = 'bonlife-google-calendar-v1';
  function output(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
  try {
    var input = JSON.parse(e.postData.contents);
    var properties = PropertiesService.getScriptProperties();
    var secret = properties.getProperty('BON_CALENDAR_SECRET');
    if (!secret || secret.length < 32 || input.secret !== secret || input.protocol !== protocol) throw new Error();
    var start = new Date(input.startDate + 'T00:00:00+08:00');
    var end = new Date(input.endDate + 'T00:00:00+08:00');
    if (!/^\d{4}-\d\d-\d\d$/.test(input.startDate) || !/^\d{4}-\d\d-\d\d$/.test(input.endDate)
      || !isFinite(start.getTime()) || !isFinite(end.getTime()) || end <= start || end - start > 1500 * 86400000
      || !/^[a-f0-9-]{36}$/.test(input.requestId)) throw new Error();
    var configured = JSON.parse(properties.getProperty('BON_CALENDARS') || '{}');
    var names = Object.keys(configured);
    if (!names.length || names.length > 20) throw new Error();
    var calendars = names.map(function(name) {
      var id = configured[name];
      if (typeof id !== 'string' || !id) throw new Error();
      var events = [], page = '', seen = {};
      do {
        var data = Calendar.Events.list(id, { singleEvents: true, showDeleted: false, maxResults: 2500,
          timeZone: 'Asia/Shanghai', timeMin: start.toISOString(), timeMax: end.toISOString(),
          fields: 'nextPageToken,items(id,iCalUID,status,summary,start,end,originalStartTime,location,description)',
          pageToken: page || undefined });
        if (data.items !== undefined && !Array.isArray(data.items)) throw new Error();
        (data.items || []).forEach(function(item) {
          if (item.status === 'cancelled') return;
          if (!item.id || !item.iCalUID || !item.start || !item.end) throw new Error();
          var link = String(item.description || '').match(/https:\/\/(?:www\.)?(?:ticktick\.com|dida365\.com)\/webapp\/#p\/([\w-]+)\/tasks\/([\w-]+)/i);
          events.push({ id: item.id, uid: item.iCalUID, title: item.summary || '',
            start: item.start.date || item.start.dateTime, end: item.end.date || item.end.dateTime,
            allDay: Boolean(item.start.date), location: item.location || '',
            recurrenceId: item.originalStartTime && (item.originalStartTime.date || item.originalStartTime.dateTime),
            taskLink: link ? { projectId: link[1], taskId: link[2] } : undefined });
        });
        if (events.length > 10000) throw new Error();
        page = data.nextPageToken || '';
        if (page && seen[page]) throw new Error();
        if (page) seen[page] = true;
        if (Object.keys(seen).length > 20) throw new Error();
      } while (page);
      return { id: id, name: name, events: events };
    });
    return output({ protocol: protocol, requestId: input.requestId, startDate: input.startDate, endDate: input.endDate,
      fetchedAt: new Date().toISOString(), complete: true, calendars: calendars });
  } catch (error) { return output({ protocol: protocol, complete: false, error: 'calendar-unavailable' }); }
}

function doGet() { return ContentService.createTextOutput('BonLife calendar reader'); }
