set OS (uname)

# Home path
switch $OS
	case Linux
		set home_path "/home/reno"
	case Darwin
		set home_path "/Users/reno"
end

# PATH Modifications
if test "$OS" = "Darwin"
	fish_add_path /opt/homebrew/bin
	fish_add_path /opt/homebrew/sbin
end
fish_add_path "$home_path/.local/bin"
fish_add_path "$home_path/.bin"
fish_add_path "$home_path/.cargo/bin"
fish_add_path "$home_path/go/bin"
fish_add_path "$home_path/.local/share/fnm"

# Remove default fish greeting
set fish_greeting ""

# NOTE: this might be bad
set -gx EDITOR nvim

# Default powerline prompt
if test "$OS" = "Darwin"
	set fish_function_path $fish_function_path "/opt/homebrew/lib/python3.9/site_packages/powerline/bindings/fish"
end

# Settings recommended by my prompt
# TODO: determine if these are actually useful
set -g theme_display_user yes
set -g theme_hostname always
set -g default_user reno 


# Init fast node manager (fnm)
fnm env | source

# Aliases
function ls
	command ls -la $argv
end
function vim
	command nvim $argv
end
function evim
	switch (uname)
		case Linux
			command nvim /home/reno/.config/nvim/init.lua
		case Darwin
			command nvim /Users/reno/.config/nvim/init.lua
		end
end

function pip
	command python3.9 -m pip $argv
end
function lg
	command lazygit
end

function dcr
	command docker-compose run $argv
end
# END
