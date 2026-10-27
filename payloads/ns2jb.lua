-- ns2jb body, loaded at boot.
-- Keep lines <=32 chars: the
-- dialog returns 32 max.
local passed = ...
local engine = passed
if type(passed) == 'table' then
  if passed.engine then
    engine = passed.engine
  end
end
local e = engine
local base = 'save:'
local v = nil
pcall(function()
  v = e:var('s.savepath')
end)
if type(v) == 'string' then
  base = v
end
local game = '?'
pcall(function()
  game = e:var('s.datapath')
end)
local lines = {}
local body = ''
local function add(t)
  t = tostring(t)
  lines[#lines+1] = t
  body = body .. t .. '\n'
end
add('ns2jb body')
add('lua ' .. _VERSION)
add('save ' .. base)
add('game ' .. tostring(game))
add('t ' .. tostring(os.time()))
local p = '/ns2jb-report.txt'
local f = io.open(base..p,'wb')
if f then
  pcall(function()
    f:write(body)
    f:flush()
    f:close()
  end)
end
pcall(function()
  e:tag{'jump',
    file='system/first.iet',
    label='title'}
end)
pcall(function()
  e:tag{'dialog',
    title='ns2jb',
    message=body}
end)
