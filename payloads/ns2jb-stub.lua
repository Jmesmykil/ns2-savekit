-- ns2jb stub: the only thing that has to change to install the untethered loop.
-- It reads save:/ns2jb.lua -- written on the console with the Lua editor -- and
-- runs it. Everything else is editable from the game itself.
function ns2jb_boot(engine)
  local base = 'save:'
  local ok, value = pcall(function() return engine:var('s.savepath') end)
  if ok and type(value) == 'string' then base = value end
  -- Escape hatch: if this file exists, do nothing at all.
  local off = io.open(base .. '/ns2jb-off.txt', 'rb')
  if off then pcall(function() off:close() end) return end
  local file, why = io.open(base .. '/ns2jb.lua', 'rb')
  if not file then
    pcall(function()
      engine:tag{'dialog', title = 'ns2jb stub', message = 'cannot open ns2jb.lua: ' .. tostring(why)}
    end)
    return
  end
  local source
  pcall(function() source = file:read('*a') end)
  pcall(function() file:close() end)
  if type(source) ~= 'string' then return end
  local chunk, err = loadstring(source, '@' .. base .. '/ns2jb.lua')
  if not chunk then
    pcall(function() engine:tag{'dialog', title = 'ns2jb stub', message = 'syntax: ' .. tostring(err)} end)
    return
  end
  local ran, failure = pcall(chunk, engine)
  if not ran then
    pcall(function() engine:tag{'dialog', title = 'ns2jb stub', message = 'body: ' .. tostring(failure)} end)
  end
end
