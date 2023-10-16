// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { ChildProcess } from 'child_process';
import path = require('path');
import * as vscode from 'vscode';

class Test {
	testCases: Array<string> = [];
}

const getpid = require('getpid');
const Tail = require('tail').Tail;
const exec = require('child_process').exec;
const spawn = require('child_process').spawn;
function execute(command: string, callback: Function) {
	exec(command, function (error: string, stdout: string, stderr: string) { callback(stdout); });
};

abstract class AbstractTestExplorer {
	public abstract uniqueId(): string;
	abstract readableDescription(): string;
	abstract getAllTestCases(controller: vscode.TestController): any;
}

class GoogleTestExplorer extends AbstractTestExplorer {
	uniqueId(): string {
		return "googleTestExplorerUniqueId12312323454yhgfngjh";
	}
	readableDescription(): string {
		return "Google tests";
	}
	getAllTestCases(controller: vscode.TestController) {
		const cmakeToolApi = vscode.extensions.getExtension("ms-vscode.cmake-tools")?.exports.getApi();

		cmakeToolApi.manager.buildDirectory().then((buildPath: string) => {
			const command = "ctest --show-only=json-v1 --test-dir " + buildPath;
			execute(command, (res: string) => {
				const json = JSON.parse(res);
				json.tests.forEach((element: any) => {
					const executable = element.command;
					const testHolder = controller.createTestItem(element.name, element.name, vscode.Uri.file(executable[0]));
					controller.items.add(testHolder);
					if (executable === undefined) {
						return;
					}
					const testListGetter = executable + ' --gtest_list_tests';
					execute(testListGetter, (tests: string) => {
						let lastTestStr = '';
						let lastTest: any = undefined;
						tests.split('\n').forEach((test: string) => {
							if (test.startsWith(' ')) {
								const testName = test.trim();
								const testCase = controller.createTestItem(lastTestStr + testName, testName);
								lastTest.children.add(testCase);
							} else {
								lastTestStr = test.trim();
								lastTest = controller.createTestItem(lastTestStr, lastTestStr);
								if (lastTestStr.length > 0) {
									testHolder.children.add(lastTest);
								}
							}
						});
					});
				});
			});
		});

	}
}

class TestFrameworkExplorer<Type extends AbstractTestExplorer>
{
	constructor(private explorer: Type) {
	}
	explore(controller: vscode.TestController) {
		const aaa = controller.createTestItem(this.explorer.uniqueId(), this.explorer.readableDescription());
		this.explorer.getAllTestCases(controller);
	}
}

class TestExecutor {
	private isDebugging: boolean;
	private wasRunningStopped: boolean;
	private testExe: ChildProcess | undefined;
	private debugOutputFile: string | undefined;
	private fileWatcher: any;

	constructor(private dataCallback: Function, private endCallback: Function) {
		this.isDebugging = false;
		this.wasRunningStopped = false;
	}
	start(shouldActivateDebug: boolean, executable: string, cliArg: string) {
		this.isDebugging = shouldActivateDebug;
		this.wasRunningStopped = false;
		if (!shouldActivateDebug) {
			this.testExe = spawn(executable, [cliArg]);
			this.testExe?.stderr?.on("data", (data: any) => {
			});

			this.testExe?.on('error', (error: Error) => {
			});
			this.testExe?.on('close', () => {
				this.handleTestingStop();
			});

			this.testExe?.stdout?.on("data", (data: Buffer) => {
				this.dataCallback(data.toString());
			});
			return;
		}

		vscode.debug.onDidTerminateDebugSession(() => {
			this.handleTestingStop();
		});

		const config = vscode.workspace.getConfiguration("launch");
		const configurations = config.get<any[]>("configurations");
		const folder = require('os').tmpdir();
		const prefix = path.join(folder, 'vscodeDebuggerTestTmpOutput');
		const suffix = ".txt";

		let i = 0;
		do {
			this.debugOutputFile = prefix + i + suffix;
			i++;
		}
		while (require('fs').existsSync(this.debugOutputFile));

		let debugConfig: vscode.DebugConfiguration = {
			name: "Test launch",
			request: "launch",
			type: "cppvsdbg"
		};
		configurations?.forEach((elem) => {
			if (elem.request === 'launch') {
				debugConfig = elem;
			}
		});
		debugConfig.program = executable;
		debugConfig.stopAtEntry = false;
		debugConfig.args = [cliArg, "&>", this.debugOutputFile];
		require('fs').writeFileSync(this.debugOutputFile, '');
		vscode.debug.startDebugging(undefined, debugConfig);

		this.fileWatcher = new Tail(this.debugOutputFile, { "fromBeginning": true, fsWatchOptions: { interval: 100 } });
		this.fileWatcher.watch();
		this.fileWatcher.on('line', (data: string) => {
			this.dataCallback(data);
		});
		this.fileWatcher.on("error", function (error: any) {
			console.log('ERROR: ', error);
		});
	}
	forceFinishExecution() {
		if (this.isDebugging) {
			vscode.debug.stopDebugging();
		} else {
			if (require('os').platform() === 'win32') {
				if (this.testExe !== undefined) {
					require('child_process').execSync('taskkill /pid ' + this.testExe.pid + ' /T /F');
				}
			} else {
				this.testExe?.kill('SIGHUP');
			}
		}
		this.handleTestingStop();
	}
	private handleTestingStop() {
		if (this.wasRunningStopped) {
			return;
		}

		this.wasRunningStopped = true;
		if (this.debugOutputFile !== undefined) {
			this.fileWatcher.unwatch();
			this.fileWatcher = undefined;
			require('fs').unlinkSync(this.debugOutputFile);
			this.debugOutputFile = undefined;
		}

		this.endCallback();
	}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	const controller = vscode.tests.createTestController("ctest-test-explorer", "Ctest test explorer");
	const updateTests = () => {
		controller.items.replace([]);
		new TestFrameworkExplorer<GoogleTestExplorer>(new GoogleTestExplorer).explore(controller);
	};
	controller.refreshHandler = (token: vscode.CancellationToken) => updateTests();

	let disposable = vscode.commands.registerCommand('ctest-test-explorer.reloadTests', () => {
		updateTests();
	});

	context.subscriptions.push(disposable);

	updateTests();

	function runHandler(
		shouldDebug: boolean,
		request: vscode.TestRunRequest,
		token: vscode.CancellationToken
	) {
		const run = controller.createTestRun(request);
		let queue: vscode.TestItem[] = [];
		let cliArg = '--gtest_filter=';

		if (request.include) {
			request.include.forEach(test => {
				if (test.uri !== undefined) {
					test.children.forEach(test => test.children.forEach(test => queue.push(test)));
					cliArg = '*';
				} else
					if (test.children.size > 0) {
						test.children.forEach(test => queue.push(test));
						cliArg += test.id + '*:';
					} else {
						queue.push(test);
						cliArg += test.id + ':';
					}
			});
		} else {
			controller.items.forEach(test => {
				if (test.children.size > 0) {
					test.children.forEach(test => queue.push(test));
					cliArg += test.id + '*:';
				} else {
					queue.push(test);
					cliArg += test.id + ':';
				}
			});
		}

		let node: vscode.TestItem | undefined = queue[0];
		let executable = node.uri?.fsPath;
		while (executable === undefined && node !== node?.parent) {
			node = node?.parent;
			executable = node?.uri?.fsPath;
		}

		if (executable === undefined) {
			run.end();
			return;
		}

		interface IDictionary {
			[index: string]: number;
		}
		var testNameToIdMap = {} as IDictionary;

		for (let i = 0; i < queue.length; i++) {
			testNameToIdMap[queue[i].id] = i;
		}

		cliArg = cliArg.slice(0, -1);

		const finishExecution = () => {
			for (const test of queue) {
				run.failed(test, new vscode.TestMessage("Test was not runned"));
			}
			run.end();
		};

		const testExe = spawn(executable, [cliArg]);

		let error = '';
		const onData = (data: string) => {
			console.log(`stdout: ${data}`);
			vscode.debug.activeDebugConsole.appendLine(data);
			const splitted = data.split('\n');
			const proccessTestResult = (testName: string, result: boolean, text: string, duration: number) => {
				const idx = testNameToIdMap[testName];
				const test = queue[idx];
				if (result) {
					run.passed(test, duration);
				}
				else {
					run.failed(test, new vscode.TestMessage(text), duration);
				}

				// remove proccessed element from queue
				if (queue.length === 1) {
					queue.length = 0;
					finishExecution();
					return;
				}
				queue[idx] = queue[queue.length - 1];
				testNameToIdMap[queue[idx].id] = idx;
				queue.pop();
			};
			splitted.forEach((line: string) => {
				const trimmed = line.trim();
				if (trimmed.startsWith('[ RUN      ] ')) {
					error = '';
					return;
				}
				if (trimmed.startsWith('[       OK ] ') && trimmed.endsWith(')')) {
					const key = trimmed.slice(13, line.lastIndexOf('(') - 1);
					proccessTestResult(key, true, '', parseInt(trimmed.match(/[0-9]+(?!.*[0-9])/)?.toString() ?? '5', 10));
					return;
				}
				if (trimmed.startsWith('[  FAILED  ] ') && trimmed.endsWith(']')) {
					const key = trimmed.slice(13, line.lastIndexOf('(') - 1);
					proccessTestResult(key, false, error, 5);
				}
				error += line + '\n';
			});
		};

		const testExecutor = new TestExecutor(onData, finishExecution);

		token.onCancellationRequested(() => {
			testExecutor.forceFinishExecution();
		});
		testExecutor.start(shouldDebug, executable, cliArg);
	}

	const runProfile = controller.createRunProfile(
		'Run',
		vscode.TestRunProfileKind.Run,
		(request, token) => {
			runHandler(false, request, token);
		}
	);

	const debugProfile = controller.createRunProfile(
		'Debug',
		vscode.TestRunProfileKind.Debug,
		(request, token) => {
			runHandler(true, request, token);
		}
	);

	context.subscriptions.push(controller);
}

// This method is called when your extension is deactivated
export function deactivate() { }
