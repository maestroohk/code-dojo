using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CodeDojo;

/// <summary>
/// Holds a started process and everything it starts, so all of it can be ended together.
///
/// Process.Kill(entireProcessTree: true) walks parent ids at the moment of the kill. A tool such as
/// npm starts a shell, which starts the real program, which starts workers. If the shell ends first,
/// its children no longer have a live parent and the walk misses them: `next dev` kept running and
/// holding its port after Stop. On Windows a Job Object fixes this. Every descendant joins the job
/// automatically, and terminating the job ends all of them whatever order they die in. With
/// <c>killOnClose</c> the operating system also ends them if this server stops or crashes.
/// Elsewhere it falls back to the process-tree kill.
/// </summary>
public sealed class ProcessTree : IDisposable
{
    readonly Process _root;
    IntPtr _job;

    ProcessTree(Process root, IntPtr job) { _root = root; _job = job; }

    /// <summary>Start tracking <paramref name="process"/> (just after Process.Start) and every process it starts.</summary>
    public static ProcessTree Track(Process process, bool killOnClose)
    {
        if (!OperatingSystem.IsWindows()) return new ProcessTree(process, IntPtr.Zero);
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return new ProcessTree(process, IntPtr.Zero);
        try
        {
            if (killOnClose)
            {
                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION { BasicLimitInformation = { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } };
                var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)size))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (!AssignProcessToJobObject(job, process.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new ProcessTree(process, job);
        }
        catch
        {
            // A process that already exited, or a policy that forbids it: fall back to the tree kill.
            CloseHandle(job);
            return new ProcessTree(process, IntPtr.Zero);
        }
    }

    /// <summary>End the process and every process it started.</summary>
    public void Kill()
    {
        var job = _job;
        if (job != IntPtr.Zero) TerminateJobObject(job, 1);
        try { if (!_root.HasExited) _root.Kill(entireProcessTree: true); } catch { /* already gone */ }
    }

    public void Dispose()
    {
        var job = Interlocked.Exchange(ref _job, IntPtr.Zero);
        if (job != IntPtr.Zero) CloseHandle(job);
    }

    // ---------------------------------------------------------------- Win32

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
}
