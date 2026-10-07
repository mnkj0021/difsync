using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    private static Mutex singleInstance;

    [STAThread]
    private static void Main(string[] args)
    {
        bool created;
        singleInstance = new Mutex(true, @"Local\DifSyncRemoteAccess", out created);
        if (!created)
        {
            MessageBox.Show("DifSync is already open.", "DifSync", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string deviceName = Environment.MachineName;
        foreach (var arg in args)
        {
            if (arg.StartsWith("--device-name=", StringComparison.OrdinalIgnoreCase))
                deviceName = arg.Substring("--device-name=".Length).Trim('"');
        }

        try
        {
            Application.Run(new DifSyncForm(installDir, deviceName));
        }
        finally
        {
            try { singleInstance.ReleaseMutex(); } catch { }
            singleInstance.Dispose();
        }
    }
}

internal sealed class DifSyncForm : Form
{
    private readonly string installDir;
    private readonly string deviceName;
    private readonly string statePath;
    private readonly string agentPath;
    private Process agentProcess;
    private bool connected;
    private NotifyIcon tray;
    private ToolStripMenuItem connectItem;
    private Label statusTitle;
    private Label statusDetail;
    private Label badge;
    private Panel statusDot;
    private Button toggleButton;
    private Button updateButton;
    private CheckBox trayCheck;

    private readonly Color Bg = Color.FromArgb(11, 15, 20);
    private readonly Color PanelColor = Color.FromArgb(18, 25, 34);
    private readonly Color Panel2 = Color.FromArgb(15, 21, 29);
    private readonly Color Line = Color.FromArgb(32, 43, 56);
    private readonly Color TextColor = Color.FromArgb(244, 247, 250);
    private readonly Color Muted = Color.FromArgb(142, 156, 175);
    private readonly Color Muted2 = Color.FromArgb(115, 128, 148);
    private readonly Color Green = Color.FromArgb(143, 174, 156);

    internal DifSyncForm(string installDir, string deviceName)
    {
        this.installDir = installDir;
        this.deviceName = deviceName;
        statePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".difsync-agent", "config.json");
        agentPath = Path.Combine(installDir, "agents", "device-agent", "src", "index.js");

        Text = "DifSync";
        ClientSize = new Size(500, 440);
        MinimumSize = new Size(516, 479);
        MaximumSize = new Size(516, 479);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Bg;
        ForeColor = TextColor;
        MaximizeBox = false;
        MinimizeBox = true;
        ShowInTaskbar = true;

        TrySetIcon();
        BuildUi();
        BuildTray();

        Shown += delegate { StartAgent(); };
        Resize += OnResize;
        FormClosing += OnFormClosing;
    }

    private Font UiFont(float size, bool bold = false)
    {
        return new Font("Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Point);
    }

    private Label Label(string text, int x, int y, int w, int h, float size, Color color, bool bold = false)
    {
        return new Label
        {
            Text = text,
            Location = new Point(x, y),
            Size = new Size(w, h),
            ForeColor = color,
            BackColor = Color.Transparent,
            Font = UiFont(size, bold)
        };
    }

    private void TrySetIcon()
    {
        try
        {
            string icoPath = Path.Combine(installDir, "apps", "web", "public", "assets", "difsync-icon.ico");
            if (File.Exists(icoPath))
            {
                Icon = new Icon(icoPath);
                return;
            }
            string iconPath = Path.Combine(installDir, "apps", "web", "public", "assets", "difsync-icon.png");
            if (!File.Exists(iconPath)) return;
            using (var bitmap = new Bitmap(iconPath))
            {
                Icon = Icon.FromHandle(bitmap.GetHicon());
            }
        }
        catch { }
    }

    private void BuildUi()
    {
        var logo = new PictureBox
        {
            Location = new Point(28, 24),
            Size = new Size(38, 38),
            SizeMode = PictureBoxSizeMode.Zoom,
            BackColor = Color.Transparent
        };
        try
        {
            if (Icon != null) logo.Image = Icon.ToBitmap();
        }
        catch { }
        Controls.Add(logo);

        Controls.Add(Label("DifSync", 78, 22, 230, 36, 20, TextColor, true));
        Controls.Add(Label("Remote Access", 78, 59, 220, 20, 9, Muted));

        var host = Label(Environment.MachineName, 350, 34, 120, 22, 8, Muted, true);
        host.TextAlign = ContentAlignment.MiddleRight;
        Controls.Add(host);

        var statusPanel = new Panel
        {
            Location = new Point(28, 96),
            Size = new Size(444, 82),
            BackColor = PanelColor
        };
        Controls.Add(statusPanel);

        statusDot = new Panel { Location = new Point(18, 33), Size = new Size(10, 10), BackColor = Muted2 };
        statusPanel.Controls.Add(statusDot);
        statusTitle = Label("Connecting", 42, 18, 240, 24, 12, TextColor, true);
        statusDetail = Label("Starting secure device session", 42, 44, 280, 18, 8, Muted);
        statusPanel.Controls.Add(statusTitle);
        statusPanel.Controls.Add(statusDetail);
        badge = Label("OFFLINE", 340, 29, 82, 24, 8, Muted, true);
        badge.TextAlign = ContentAlignment.MiddleCenter;
        statusPanel.Controls.Add(badge);

        var infoPanel = new Panel
        {
            Location = new Point(28, 194),
            Size = new Size(444, 105),
            BackColor = Panel2
        };
        Controls.Add(infoPanel);

        infoPanel.Controls.Add(Label("Device", 16, 14, 90, 18, 8, Muted2));
        infoPanel.Controls.Add(Label(deviceName, 118, 14, 300, 18, 9, TextColor, true));
        infoPanel.Controls.Add(Label("Device ID", 16, 44, 90, 18, 8, Muted2));
        infoPanel.Controls.Add(Label(ReadAgentId(), 118, 44, 300, 18, 8, TextColor));
        infoPanel.Controls.Add(Label("Access", 16, 74, 90, 18, 8, Muted2));
        infoPanel.Controls.Add(Label("Reachable only while DifSync is running", 118, 74, 300, 18, 8, Muted));

        toggleButton = Button("Disconnect", 28, 317, 216, 42, true);
        toggleButton.Click += delegate { if (connected) StopAgent(); else StartAgent(); };
        Controls.Add(toggleButton);

        var webButton = Button("Open web dashboard", 256, 317, 216, 42, false);
        webButton.Click += delegate
        {
            try { Process.Start(new ProcessStartInfo("https://difsync.com/devices") { UseShellExecute = true }); } catch { }
        };
        Controls.Add(webButton);

        updateButton = Button("Update DifSync", 28, 371, 444, 34, false);
        updateButton.Click += delegate { StartSelfUpdate(); };
        Controls.Add(updateButton);

        trayCheck = new CheckBox
        {
            Location = new Point(28, 415),
            Size = new Size(150, 20),
            Text = "Minimize to tray",
            Checked = true,
            ForeColor = Muted,
            BackColor = Bg,
            Font = UiFont(8)
        };
        Controls.Add(trayCheck);

        var closeHint = Label("Close = PC offline", 330, 415, 142, 18, 8, Muted2);
        closeHint.TextAlign = ContentAlignment.MiddleRight;
        Controls.Add(closeHint);
    }

    private Button Button(string text, int x, int y, int w, int h, bool primary)
    {
        var button = new Button
        {
            Text = text,
            Location = new Point(x, y),
            Size = new Size(w, h),
            FlatStyle = FlatStyle.Flat,
            BackColor = primary ? Color.FromArgb(232, 237, 243) : Color.FromArgb(21, 29, 39),
            ForeColor = primary ? Color.FromArgb(16, 21, 27) : TextColor,
            Font = UiFont(9, true),
            Cursor = Cursors.Hand
        };
        button.FlatAppearance.BorderSize = primary ? 0 : 1;
        button.FlatAppearance.BorderColor = Line;
        return button;
    }

    private void BuildTray()
    {
        tray = new NotifyIcon
        {
            Text = "DifSync Remote Access",
            Icon = Icon ?? SystemIcons.Application,
            Visible = false
        };

        var menu = new ContextMenuStrip();
        var openItem = new ToolStripMenuItem("Open DifSync");
        openItem.Click += delegate { RestoreWindow(); };
        connectItem = new ToolStripMenuItem("Disconnect");
        connectItem.Click += delegate { if (connected) StopAgent(); else StartAgent(); };
        var updateItem = new ToolStripMenuItem("Update DifSync");
        updateItem.Click += delegate { StartSelfUpdate(); };
        var exitItem = new ToolStripMenuItem("Exit");
        exitItem.Click += delegate { Close(); };

        menu.Items.Add(openItem);
        menu.Items.Add(connectItem);
        menu.Items.Add(updateItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += delegate { RestoreWindow(); };
    }

    private string ReadAgentId()
    {
        try
        {
            if (!File.Exists(statePath)) return "Not paired";
            string json = File.ReadAllText(statePath);
            var match = Regex.Match(json, "\\\"agent_id\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
            return match.Success ? match.Groups[1].Value : "Paired";
        }
        catch { return "Unable to read state"; }
    }

    private void SetStatus(bool online, string detail)
    {
        connected = online;
        if (online)
        {
            statusDot.BackColor = Green;
            statusTitle.Text = "Online";
            statusDetail.Text = detail;
            badge.Text = "ONLINE";
            badge.ForeColor = Green;
            toggleButton.Text = "Disconnect";
            connectItem.Text = "Disconnect";
        }
        else
        {
            statusDot.BackColor = Muted2;
            statusTitle.Text = "Offline";
            statusDetail.Text = detail;
            badge.Text = "OFFLINE";
            badge.ForeColor = Muted;
            toggleButton.Text = "Connect";
            connectItem.Text = "Connect";
        }
    }

    private void StartAgent()
    {
        if (agentProcess != null && !agentProcess.HasExited) return;
        if (!File.Exists(agentPath))
        {
            SetStatus(false, "Agent missing. Repair DifSync from difsync.com/devices.");
            return;
        }
        if (!File.Exists(statePath))
        {
            SetStatus(false, "This PC is not paired yet.");
            return;
        }

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "node.exe",
                Arguments = "\"agents/device-agent/src/index.js\"",
                WorkingDirectory = installDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            psi.EnvironmentVariables["DIFSYNC_DEVICE_NAME"] = deviceName;
            agentProcess = Process.Start(psi);
            Thread.Sleep(700);
            if (agentProcess == null || agentProcess.HasExited)
                SetStatus(false, "The device agent stopped unexpectedly.");
            else
                SetStatus(true, "Connected securely to DifSync");
        }
        catch (Exception ex)
        {
            SetStatus(false, ex.Message);
        }
    }

    private void StopAgent()
    {
        try
        {
            if (agentProcess != null && !agentProcess.HasExited)
            {
                agentProcess.Kill();
                agentProcess.WaitForExit(2000);
            }
        }
        catch { }
        agentProcess = null;
        SetStatus(false, "This PC is not reachable remotely");
    }

    private void SendToTray()
    {
        tray.Visible = true;
        ShowInTaskbar = false;
        Hide();
    }

    private void RestoreWindow()
    {
        tray.Visible = false;
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void StartSelfUpdate()
    {
        try
        {
            updateButton.Enabled = false;
            updateButton.Text = "Updating...";

            int pid = Process.GetCurrentProcess().Id;
            string installer = Path.Combine(Path.GetTempPath(), "difsync-install.ps1");
            string command =
                "$p=Get-Process -Id " + pid + " -ErrorAction SilentlyContinue; " +
                "if($p){$p.WaitForExit()}; " +
                "iwr 'https://difsync.com/install/windows.ps1' -UseBasicParsing -OutFile '" + installer.Replace("'", "''") + "'; " +
                "& '" + installer.Replace("'", "''") + "'";

            Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"" + command.Replace("\"", "\\\"") + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });

            Close();
        }
        catch (Exception ex)
        {
            updateButton.Enabled = true;
            updateButton.Text = "Update DifSync";
            MessageBox.Show("Update could not start.\r\n\r\n" + ex.Message, "DifSync", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void OnResize(object sender, EventArgs e)
    {
        if (WindowState == FormWindowState.Minimized && trayCheck.Checked) SendToTray();
    }

    private void OnFormClosing(object sender, FormClosingEventArgs e)
    {
        StopAgent();
        tray.Visible = false;
        tray.Dispose();
    }
}
