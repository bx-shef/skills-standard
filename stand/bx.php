<?php
/**
 * Обвязка для прогона на стенде. Запускается ВНУТРИ php-контейнера:
 *
 *   docker exec dev_php php /opt/www/tools/bx.php <команда> [аргумент]
 *
 * Команды:
 *   status    <module>   установлен ли, версия, агенты, опции
 *   install   <module>   DoInstall() из local/modules/<module>
 *   uninstall <module>   DoUninstall() + принудительная зачистка следов
 *   reset     <module>   привести портал к состоянию «модуля не было»: снять регистрацию, вычистить
 *                        следы в таблицах, удалить файлы. DoUninstall НЕ зовётся — сломанный
 *                        install/index.php не должен ронять reset
 *   footprint <module>   след модуля на портале одной строкой на сущность: регистрация, b_agent,
 *                        b_option, b_module_to_module, UF по префиксу, файлы вне каталога модуля.
 *                        Снимать до установки, после установки и после удаления — diff покажет остатки
 *   agents    <module>   строки b_agent модуля
 *   run-agent <module>   выполнить функцию каждого агента модуля так же, как CAgent (eval NAME)
 *   options   <module>   строки b_option модуля
 *   uf        <FIELD>    пользовательское поле по FIELD_NAME (все ENTITY_ID)
 *   sql       "<query>"  выполнить SELECT и напечатать строки (только чтение)
 *
 * Скрипт не ходит в админку и не требует логина: капча не нужна.
 * Ненулевой код возврата = не вышло.
 */

$_SERVER['DOCUMENT_ROOT'] = getenv('BX_DOCROOT') ?: '/opt/www';
define('NO_KEEP_STATISTIC', true);
define('NOT_CHECK_PERMISSIONS', true);
define('BX_NO_ACCELERATOR_RESET', true);
define('BX_CRONTAB', true);
define('BX_WITH_ON_AFTER_EPILOG', true);
define('STOP_STATISTICS', true);

require $_SERVER['DOCUMENT_ROOT'].'/bitrix/modules/main/include/prolog_before.php';

use Bitrix\Main\Application;
use Bitrix\Main\Config\Option;
use Bitrix\Main\ModuleManager;

$cmd = $argv[1] ?? '';
$arg = $argv[2] ?? '';

function out(string $s): void { fwrite(STDOUT, $s.PHP_EOL); }
function fail(string $s, int $code = 1): never { fwrite(STDERR, '[FAIL] '.$s.PHP_EOL); exit($code); }
function rows(string $sql): array
{
	$res = Application::getConnection()->query($sql);
	$list = [];
	while($row = $res->fetch()) $list[] = $row;
	return $list;
}
function table(array $list): void
{
	if(!$list) { out('(пусто)'); return; }
	out(implode(' | ', array_keys($list[0])));
	foreach($list as $row) out(implode(' | ', array_map(static fn($v) => is_null($v) ? 'NULL' : mb_substr((string)$v, 0, 80), $row)));
}
function moduleObject(string $id): ?CModule
{
	$path = $_SERVER['DOCUMENT_ROOT'].'/local/modules/'.$id.'/install/index.php';
	if(!is_file($path)) $path = $_SERVER['DOCUMENT_ROOT'].'/bitrix/modules/'.$id.'/install/index.php';
	if(!is_file($path)) return null;
	$obj = CModule::CreateModuleObject($id);
	return $obj ?: null;
}
function q(string $s): string { return Application::getConnection()->getSqlHelper()->forSql($s); }

if($arg === '' && $cmd !== '') fail('нужен аргумент: '.$cmd.' <module|FIELD|sql>');

switch($cmd)
{
	case 'status':
		out('installed: '.(ModuleManager::isModuleInstalled($arg) ? 'yes' : 'no'));
		out('version:   '.(ModuleManager::getVersion($arg) ?: '-'));
		out('files:     '.(is_dir($_SERVER['DOCUMENT_ROOT'].'/local/modules/'.$arg) ? 'local/modules/'.$arg : (is_dir($_SERVER['DOCUMENT_ROOT'].'/bitrix/modules/'.$arg) ? 'bitrix/modules/'.$arg : 'нет')));
		out('agents:    '.count(rows("SELECT ID FROM b_agent WHERE MODULE_ID='".q($arg)."'")));
		out('options:   '.count(rows("SELECT NAME FROM b_option WHERE MODULE_ID='".q($arg)."'")));
		break;

	case 'install':
		$m = moduleObject($arg) ?? fail('нет install/index.php у '.$arg);
		if(ModuleManager::isModuleInstalled($arg)) fail('уже установлен', 3);
		// Генераторы часто зовут IncludeAdminFile() в конце DoInstall — это die().
		// Ловим через shutdown: если после DoInstall модуль числится установленным — успех.
		register_shutdown_function(static function() use ($arg) {
			out('installed after DoInstall: '.(ModuleManager::isModuleInstalled($arg) ? 'yes' : 'NO'));
			if(!ModuleManager::isModuleInstalled($arg)) exit(1);
		});
		$m->DoInstall();
		break;

	case 'uninstall':
		$m = moduleObject($arg);
		if($m && ModuleManager::isModuleInstalled($arg))
		{
			register_shutdown_function(static function() use ($arg) {
				$e = error_get_last();
				if($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true))
					out('DoUninstall УПАЛ: '.$e['message'].' @ '.$e['file'].':'.$e['line'].'  (дефект модуля)');
				cleanup($arg, false);
			});
			try { $m->DoUninstall(); }
			catch(Throwable $t) { out('DoUninstall бросил '.get_class($t).': '.$t->getMessage().' @ '.$t->getFile().':'.$t->getLine().'  (дефект модуля)'); }
		}
		cleanup($arg, false);
		break;

	case 'reset':
		// reset сносит каталоги вендора целиком (local/components/<vendor> и т.п.) —
		// для настоящих модулей это опасно. Только тестовый вендор acme.*.
		if(!str_starts_with($arg, 'acme.') && ($argv[3] ?? '') !== '--force') fail('reset только для acme.*; для других модулей — uninstall, либо reset <id> --force');
		// Нарочно без DoUninstall: reset нужен и тогда, когда install/index.php
		// предыдущего прогона роняет PHP. Остатки, которые DoUninstall должен был
		// убрать сам, здесь не считаются дефектом — их меряет uninstall + footprint.
		cleanup($arg, true, true);
		break;

	case 'footprint':
		footprint($arg);
		break;

	case 'agents':
		table(rows("SELECT ID, NAME, ACTIVE, AGENT_INTERVAL, IS_PERIOD, RUNNING, LAST_EXEC, NEXT_EXEC, USER_ID FROM b_agent WHERE MODULE_ID='".q($arg)."'"));
		break;

	case 'run-agent':
		register_shutdown_function(static function() {
			$e = error_get_last();
			if($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true))
				out('  FATAL: '.$e['message'].' @ '.$e['file'].':'.$e['line']);
		});
		if(!CModule::IncludeModule($arg)) fail('модуль не подключается: '.$arg);
		$list = rows("SELECT ID, NAME FROM b_agent WHERE MODULE_ID='".q($arg)."'");
		if(!$list) fail('агентов у '.$arg.' нет');
		foreach($list as $a)
		{
			out('> '.$a['NAME']);
			$t = microtime(true);
			try
			{
				$r = eval('return '.$a['NAME']);
				out('  returned: '.var_export($r, true).'  ('.round(microtime(true) - $t, 1).'s)');
			}
			catch(Throwable $e)
			{
				out('  THROWN: '.get_class($e).': '.$e->getMessage().'  ('.round(microtime(true) - $t, 1).'s)');
			}
		}
		break;

	case 'options':
		table(rows("SELECT NAME, VALUE, SITE_ID FROM b_option WHERE MODULE_ID='".q($arg)."'"));
		break;

	case 'uf':
		table(rows("SELECT ID, ENTITY_ID, FIELD_NAME, USER_TYPE_ID, MULTIPLE, MANDATORY FROM b_user_field WHERE FIELD_NAME='".q($arg)."'"));
		break;

	case 'sql':
		if(!preg_match('/^\s*(select|show|describe)\b/i', $arg)) fail('только SELECT/SHOW/DESCRIBE');
		table(rows($arg));
		break;

	default:
		fwrite(STDERR, "команды: status|install|uninstall|reset|footprint|agents|run-agent|options <module>, uf <FIELD>, sql \"<select>\"\n");
		exit(2);
}

exit(0);

function cleanup(string $id, bool $removeFiles, bool $quietLeftovers = false): void
{
	static $done = false;
	if($done) return;
	$done = true;

	$c = Application::getConnection();
	$idq = q($id);

	if(ModuleManager::isModuleInstalled($id))
	{
		ModuleManager::unRegisterModule($id);
		out('unRegisterModule: принудительно');
	}

	$tag = $quietLeftovers ? '' : ' (остаток после DoUninstall — дефект)';
	$n = count(rows("SELECT ID FROM b_agent WHERE MODULE_ID='$idq'"));
	if($n) { $c->queryExecute("DELETE FROM b_agent WHERE MODULE_ID='$idq'"); out("b_agent: удалено $n$tag"); }

	$n = count(rows("SELECT NAME FROM b_option WHERE MODULE_ID='$idq'"));
	if($n) { Option::delete($id); out("b_option: удалено $n$tag"); }

	$prefix = 'UF_'.strtoupper(preg_replace('/[^a-z0-9]/i', '', explode('.', $id)[0]));
	// UF по префиксу вендора: удалять только на reset (acme.*). У настоящих модулей
	// префикс общий с соседями (UF_SHEF_* у shef.options и shef.leadfinish) — при
	// uninstall только сообщаем, что осталось.
	foreach(rows("SELECT ID, FIELD_NAME, ENTITY_ID FROM b_user_field WHERE FIELD_NAME LIKE '".q($prefix)."%'") as $uf)
	{
		if($removeFiles) { (new CUserTypeEntity())->Delete((int)$uf['ID']); out('b_user_field: удалено '.$uf['ENTITY_ID'].'.'.$uf['FIELD_NAME'].$tag); }
		else out('b_user_field: осталось '.$uf['ENTITY_ID'].'.'.$uf['FIELD_NAME'].' (по префиксу вендора; дефект, если поле этого модуля)');
	}

	$n = count(rows("SELECT ID FROM b_module_to_module WHERE TO_MODULE_ID='$idq' OR FROM_MODULE_ID='$idq'"));
	if($n) { $c->queryExecute("DELETE FROM b_module_to_module WHERE TO_MODULE_ID='$idq' OR FROM_MODULE_ID='$idq'"); out("b_module_to_module: удалено $n$tag"); }

	if($removeFiles)
	{
		$vendor = explode('.', $id)[0];
		$dirs = ['/local/modules/'.$id, '/local/components/'.$vendor, '/local/components/'.$id, '/bitrix/js/'.$id, '/bitrix/css/'.$id, '/bitrix/tmp/'.$id];
		foreach(glob($_SERVER['DOCUMENT_ROOT'].'/upload/tmp/*/'.$id.'*', GLOB_ONLYDIR) ?: [] as $g) $dirs[] = substr($g, strlen($_SERVER['DOCUMENT_ROOT']));
		foreach($dirs as $dir)
		{
			$full = $_SERVER['DOCUMENT_ROOT'].$dir;
			if(is_dir($full)) { DeleteDirFilesEx($dir); out('удалён каталог '.$dir); }
		}
		foreach(glob($_SERVER['DOCUMENT_ROOT'].'/bitrix/admin/'.str_replace('.', '_', $id).'_*.php') ?: [] as $f) { unlink($f); out('удалён файл /bitrix/admin/'.basename($f)); }
	}

	out('cleanup done: '.$id);
}

function footprint(string $id): void
{
	$idq = q($id);
	$vendor = explode('.', $id)[0];
	$root = $_SERVER['DOCUMENT_ROOT'];
	$prefix = 'UF_'.strtoupper(preg_replace('/[^a-z0-9]/i', '', $vendor));

	out('registered   '.(ModuleManager::isModuleInstalled($id) ? 'yes '.ModuleManager::getVersion($id) : 'no'));
	foreach(rows("SELECT NAME FROM b_agent WHERE MODULE_ID='$idq' ORDER BY NAME") as $r) out('agent        '.$r['NAME']);
	foreach(rows("SELECT NAME, SITE_ID FROM b_option WHERE MODULE_ID='$idq' ORDER BY NAME") as $r) out('option       '.$r['NAME'].($r['SITE_ID'] ? ' ['.$r['SITE_ID'].']' : ''));
	foreach(rows("SELECT FROM_MODULE_ID, MESSAGE_ID, TO_CLASS, TO_METHOD FROM b_module_to_module WHERE TO_MODULE_ID='$idq' ORDER BY MESSAGE_ID") as $r) out('event        '.$r['FROM_MODULE_ID'].':'.$r['MESSAGE_ID'].' -> '.$r['TO_CLASS'].'::'.$r['TO_METHOD']);
	foreach(rows("SELECT ENTITY_ID, FIELD_NAME FROM b_user_field WHERE FIELD_NAME LIKE '".q($prefix)."%' ORDER BY ENTITY_ID, FIELD_NAME") as $r) out('uf           '.$r['ENTITY_ID'].'.'.$r['FIELD_NAME']);
	try { foreach(rows("SELECT TITLE FROM b_crm_dynamic_type WHERE CODE LIKE '".q(strtoupper($vendor))."%' ORDER BY TITLE") as $r) out('smart        '.$r['TITLE']); } catch(Throwable) {}

	// Каталог самого модуля печатается отдельной строкой module-dir: он остаётся после
	// uninstall всегда, и остатком не считается. Всё, что dir, — след вне модуля.
	foreach(['/local/modules/'.$id, '/bitrix/modules/'.$id] as $d) if(is_dir($root.$d)) out('module-dir   '.$d.'  ('.countFiles($root.$d).' файлов)');
	$dirs = ['/local/components/'.$vendor, '/local/components/'.$id, '/bitrix/components/'.$vendor, '/bitrix/components/'.$id,
		'/bitrix/js/'.$id, '/bitrix/css/'.$id, '/local/js/'.$id, '/bitrix/tmp/'.$id, '/upload/'.$id];
	foreach(glob($root.'/upload/tmp/*/'.$id.'*', GLOB_ONLYDIR) ?: [] as $g) $dirs[] = substr($g, strlen($root));
	foreach(glob($root.'/upload/tmp/'.$id.'*', GLOB_ONLYDIR) ?: [] as $g) $dirs[] = substr($g, strlen($root));
	foreach(array_unique($dirs) as $d) if(is_dir($root.$d)) out('dir          '.$d.'  ('.countFiles($root.$d).' файлов)');
	foreach(glob($root.'/bitrix/admin/'.str_replace('.', '_', $id).'_*.php') ?: [] as $f) out('admin        /bitrix/admin/'.basename($f));
	foreach(glob($root.'/local/admin/'.str_replace('.', '_', $id).'_*.php') ?: [] as $f) out('admin        /local/admin/'.basename($f));

	// Файлы ядра, изменённые недавно: ловит затирание /bitrix/admin/menu.php и подобное.
	$recent = [];
	foreach(['/bitrix/admin', '/bitrix/php_interface', '/bitrix/.settings.php'] as $p)
	{
		$full = $root.$p;
		if(is_file($full)) { if(filemtime($full) > time() - 3600) $recent[] = $p; continue; }
		foreach(scandir($full) ?: [] as $f)
		{
			if($f === '.' || $f === '..' || !is_file($full.'/'.$f)) continue;
			if(str_starts_with($f, str_replace('.', '_', $id).'_')) continue;
			if(filemtime($full.'/'.$f) > time() - 3600) $recent[] = $p.'/'.$f;
		}
	}
	foreach($recent as $f) out('CORE-TOUCHED '.$f.'  (изменён за последний час — проверить)');
}

function countFiles(string $dir): int
{
	$n = 0;
	foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)) as $f) $n++;
	return $n;
}
