-- ns2jb body: this is the file the stub loads at boot.
-- Edit it on the console with the Lua editor (Save file -> ns2jb.lua) and
-- restart the game; no PC and no exploit session are involved.
local engine = ...
local base = 'save:'
local ok, value = pcall(function() return engine:var('s.savepath') end)
if ok and type(value) == 'string' then base = value end
local game = '?'
pcall(function() game = tostring(engine:var('s.datapath')) end)

local lines = {}
local function add(text) lines[#lines + 1] = tostring(text) end
add('ns2jb body: untethered boot')
add('lua ' .. tostring(_VERSION))
add('save ' .. base .. '  game ' .. game)
add('io.open ' .. type(io.open) .. '  loadstring ' .. type(loadstring) .. '  os.time ' .. tostring(os.time()))

local report = io.open(base .. '/ns2jb-report.txt', 'wb')
if report then
  pcall(function()
    report:write(table.concat(lines, '\n') .. '\n')
    report:flush()
    report:close()
  end)
end

-- Put the game back where it belongs, then say hello over the live UI.
pcall(function() engine:tag{'jump', file = 'system/first.iet', label = 'title'} end)
pcall(function() engine:tag{'dialog', title = 'ns2jb', message = table.concat(lines, '\n')} end)
