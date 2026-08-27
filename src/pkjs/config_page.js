/* Self-contained settings page. Served via a data: URI so no hosting is
 * required. Submits back to the watch app through the pebblejs://close#<json>
 * redirect that the Pebble app intercepts. */

function buildConfigPage(settings, usage) {
  var s = settings || {};
  var u = usage || {};
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  var miChecked = s.units === 'km' ? '' : 'checked';
  var kmChecked = s.units === 'km' ? 'checked' : '';

  var ch = parseInt(s.cacheHours, 10) || 24;
  function opt(v, txt) {
    return '<option value="' + v + '"' + (ch === v ? ' selected' : '') + '>' + txt + '</option>';
  }

  // --- usage card -----------------------------------------------------------
  var usageRows = '';
  var a = u.account;
  if (a && a.perMonth != null) {
    var used = (a.usedThisMonth != null) ? a.usedThisMonth : (a.perMonth - (a.planLeft || 0));
    var left = (a.totalLeft != null) ? a.totalLeft : Math.max(0, a.perMonth - used);
    var pct = Math.min(100, Math.round((used / a.perMonth) * 100));
    usageRows +=
      '<div class="bar"><div class="fill" style="width:' + pct + '%"></div></div>' +
      '<div class="big">' + used + ' <span class="muted">/ ' + a.perMonth + ' this month</span></div>' +
      '<div class="hint">' + left + ' searches left on your SerpApi plan.</div>';
  } else if (s.serpApiKey) {
    usageRows += '<div class="hint">Couldn\'t reach SerpApi for your plan usage.</div>';
  } else {
    usageRows += '<div class="hint">Add a SerpApi key to see plan usage.</div>';
  }
  if (u.localCalls != null) {
    usageRows += '<div class="hint" style="margin-top:8px">This watch app has made <b>' +
      u.localCalls + '</b> SerpApi call' + (u.localCalls === 1 ? '' : 's') +
      (u.localSince ? ' since ' + esc(u.localSince) : '') + '. ' +
      '<a href="#" id="resetCount">Reset</a></div>';
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Movie Times Settings</title><style>' +
    'body{font-family:-apple-system,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#f2f2f2;color:#222}' +
    '.wrap{max-width:520px;margin:0 auto;padding:20px}' +
    'h1{font-size:20px;margin:8px 0 4px}p.sub{margin:0 0 20px;color:#666;font-size:13px}' +
    '.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}' +
    'label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}' +
    '.hint{font-weight:400;color:#888;font-size:12px;margin:2px 0 10px}' +
    '.muted{color:#999;font-weight:400}' +
    '.big{font-size:22px;font-weight:700;margin:6px 0 2px}' +
    '.bar{height:8px;border-radius:4px;background:#eee;overflow:hidden;margin-bottom:8px}' +
    '.fill{height:100%;background:#e64a19}' +
    'input[type=text]{width:100%;box-sizing:border-box;padding:11px;border:1px solid #ccc;' +
    'border-radius:8px;font-size:15px}' +
    '.radios{display:flex;gap:16px;margin-top:4px}.radios label{font-weight:400;display:flex;' +
    'align-items:center;gap:6px;margin:0}' +
    'select{width:100%;box-sizing:border-box;padding:11px;border:1px solid #ccc;' +
    'border-radius:8px;font-size:15px;background:#fff}' +
    'button{width:100%;padding:14px;border:0;border-radius:10px;background:#e64a19;color:#fff;' +
    'font-size:16px;font-weight:600;margin-top:4px}' +
    'a{color:#e64a19}' +
    '</style></head><body><div class="wrap">' +
    '<h1>Movie Times</h1><p class="sub">Theaters, showtimes and ratings near you.</p>' +

    '<div class="card"><label>SerpApi usage</label>' + usageRows + '</div>' +

    '<div class="card">' +
    '<label>SerpApi key <span style="color:#e64a19">*</span></label>' +
    '<div class="hint">Required. Free key at <a href="https://serpapi.com/manage-api-key">serpapi.com</a> ' +
    '(100 searches/month free).</div>' +
    '<input type="text" id="serp" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
    'placeholder="Paste SerpApi key" value="' + esc(s.serpApiKey) + '">' +
    '</div>' +

    '<div class="card">' +
    '<label>OMDb key</label>' +
    '<div class="hint">Optional, adds IMDb ratings. Free key at ' +
    '<a href="https://www.omdbapi.com/apikey.aspx">omdbapi.com</a>.</div>' +
    '<input type="text" id="omdb" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
    'placeholder="Paste OMDb key" value="' + esc(s.omdbApiKey) + '">' +
    '</div>' +

    '<div class="card">' +
    '<label>Distance units</label>' +
    '<div class="radios">' +
    '<label><input type="radio" name="units" value="mi" ' + miChecked + '> Miles</label>' +
    '<label><input type="radio" name="units" value="km" ' + kmChecked + '> Kilometers</label>' +
    '</div></div>' +

    '<div class="card">' +
    '<label>Cache showtimes for</label>' +
    '<div class="hint">Longer = fewer SerpApi searches, older times. Showtimes ' +
    'always refresh at midnight, and a shake refreshes now.</div>' +
    '<select id="cache">' +
    opt(6, '6 hours') + opt(24, '24 hours') + opt(48, '48 hours') +
    '</select></div>' +

    '<button id="save">Save</button>' +
    '</div><script>' +
    'var resetCount=false;' +
    'var rc=document.getElementById("resetCount");' +
    'if(rc){rc.addEventListener("click",function(e){e.preventDefault();resetCount=true;' +
    'rc.textContent="will reset on save";});}' +
    'function getUnits(){var r=document.getElementsByName("units");' +
    'for(var i=0;i<r.length;i++){if(r[i].checked)return r[i].value;}return "mi";}' +
    'document.getElementById("save").addEventListener("click",function(){' +
    'var out={serpApiKey:document.getElementById("serp").value.trim(),' +
    'omdbApiKey:document.getElementById("omdb").value.trim(),units:getUnits(),' +
    'cacheHours:parseInt(document.getElementById("cache").value,10),' +
    'resetCounter:resetCount};' +
    'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify(out));});' +
    '</script></body></html>';
}

module.exports = { buildConfigPage: buildConfigPage };
