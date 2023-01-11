# NOTE: fish_add_path requires fish > 3.2
# Home path
set OS (uname)
# TODO: Change this dynamically for macOS/Linux
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
fish_add_path "$home_path/.bin"
fish_add_path "$home_path/.cargo/bin"
fish_add_path "$home_path/go/bin"

# Remove default fish greeting
set fish_greeting ""

# NOTE: this might be bad
# set -gx COLORTERM truecolor
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

# OS Specific
if test "$OS" = "Linux"
	function docker
		command sudo docker $argv
	end
	function docker-compose
		command sudo docker-compose $argv
	end
end

function ls
	command ls -la $argv
end
function vim
	command nvim $argv
end
function vim
	command nvim $argv
end
function evim
	switch (uname)
		case Linux
			command nvim /home/reno/.config/nvim/init.vim
		case Darwin
			command nvim /Users/reno/.config/nvim/init.vim
		end
end

function pip
	command python3.9 -m pip $argv
end
function lg
	command lazygit
end

# START: m1 Specific Aliases
function brew
	command arch -arm64 brew $argv
end

function brew64
	command arch -x86_64 /usr/local/bin/brew $argv
end

alias ttp="cd '/Users/reno/Library/Application Support/Steam/steamapps/common/TabletopPlayground/Tabletop Playground.app/Contents/UE4/TabletopPlayground/'"

function dcr
	command docker-compose run $argv
end
# A very specific alias that lets me run Python inside of the Docker compose
# container used for the DSA site
function dcp
	command docker-compose run django python $argv
end

# Aliases to x86_64 versions of programs
function py64
	command /usr/local/bin/python3 $argv
end


# END
fish_add_path /opt/homebrew/opt/php@7.4/bin
fish_add_path /opt/homebrew/opt/php@7.4/sbin
